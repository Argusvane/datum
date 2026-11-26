import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { runFormTestScenario } from "../../form-engine/core/form-tests/form-test-run.js";
import type { FormTestScenario, FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import type { Journey } from "../../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import { createFormTestKernelDriver } from "../../form-engine/validation/wasm/form-test-kernel-driver.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import {
  kernelFoldSubmission,
  kernelIsJourney,
  kernelPartitionValues,
  kernelPrepareDefinition
} from "../../form-engine/validation/wasm/portable-kernel.js";

/**
 * The validation kernel's form-test driver: the server's reading of a
 * scenario, over the in-process kernel. The fixture is this file's own and small: a field shown
 * and required by a rule, an exit route, a rule reading `host.`, a `run: "server"` rule, a
 * repeating section, a calculation and a data-source choice.
 */

const root: ComponentNode = {
  id: "form",
  type: "form",
  configuration: { messages: { required: "Answer this" } },
  children: {
    content: [
      { id: "business_structure", type: "text", configuration: {} },
      {
        id: "registered_agent",
        type: "text",
        configuration: { required: true, hiddenValueBehavior: "exclude-from-submission" },
        rules: { visibleWhen: 'business_structure = "Partnership"' }
      },
      {
        id: "server_code",
        type: "text",
        configuration: {},
        rules: { requiredWhen: { formula: 'business_structure = "Partnership"', run: "server" } }
      },
      { id: "role_note", type: "text", configuration: {}, rules: { visibleWhen: 'host.role = "admin"' } },
      { id: "stop_note", type: "text", configuration: {} },
      { id: "subtotal", type: "number", configuration: {} },
      { id: "total", type: "number", configuration: {}, rules: { value: "subtotal * 2" } },
      { id: "province", type: "select", configuration: { data: { sourceId: "provinces" } } },
      {
        id: "items",
        type: "repeatingSection",
        configuration: {},
        collection: { collectionPath: "items" },
        children: { content: [{ id: "qty", type: "number", configuration: {} }] }
      }
    ]
  }
} as unknown as ComponentNode;

const journey = {
  id: "main",
  validation: { continue: "page" },
  pages: [
    {
      id: "intro",
      components: ["business_structure"],
      routes: [{ when: 'business_structure = "STOP"', to: "stop" }, { to: "agent" }]
    },
    { id: "stop", kind: "exit", components: ["stop_note"] },
    { id: "agent", components: ["registered_agent", "server_code"] },
    { id: "details", components: ["subtotal", "total", "items", "role_note", "province"] }
  ]
} as unknown as Journey;

const definition = {
  id: "kernel-driver-fixture",
  version: "1",
  schemaVersion: "1",
  root,
  journey: { journeys: [journey] },
  // The form's own required message in French (at form › messages › required in the map).
  translations: { fr: { form: { messages: { required: { text: "Répondez", source: "1hsxua1" } } } } }
} as unknown as FormDefinition;

/** A form whose one rule reads the clock. */
const clockDefinition = {
  id: "clock-fixture",
  version: "1",
  schemaVersion: "1",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "late_fee", type: "text", configuration: {}, rules: { visibleWhen: 'today() > "2026-01-31"' } }
      ]
    }
  }
} as unknown as FormDefinition;

const host = createInProcessWasmValidationHost();

function scenarios(source: string): FormTestScenario[] {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  return parsed.scenarios;
}

async function run(source: string, form: FormDefinition = definition): Promise<FormTestScenarioResult> {
  const [scenario] = scenarios(source);
  return runFormTestScenario(scenario as FormTestScenario, createFormTestKernelDriver(form, { host }));
}

/** The steps that did not pass or run, for a readable failure. */
function trouble(result: FormTestScenarioResult): unknown[] {
  return result.steps.filter((step) => step.status !== "passed" && step.status !== "ran");
}

describe("the kernel driver: verdicts", () => {
  it("refuses a missing required answer with the code `required`, and accepts once it is given", async () => {
    const result = await run(`test "A partnership needs a registered agent"
  given journey = none
  set business_structure = "Partnership"
  expect registered_agent visible
  expect registered_agent required
  submit
  expect refused
  expect error on registered_agent: required
  set registered_agent = "Jane Doe"
  set server_code = "S-1"
  submit
  expect accepted
  expect submitted registered_agent = "Jane Doe"
  expect no errors`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("fails an expectation the form does not meet, with what the snapshot held", async () => {
    const result = await run(`test "Wrong"
  given journey = none
  set business_structure = "Partnership"
  expect registered_agent hidden
  check
  expect accepted`);
    expect(result.status).toBe("failed");
    expect(trouble(result)).toEqual([
      { line: 4, status: "failed", code: "expect.hidden", expected: true, actual: false, params: { path: "registered_agent" } },
      { line: 6, status: "failed", code: "expect.verdict", expected: "accepted", actual: "refused" }
    ]);
  });

  it("applies a `run: \"server\"` rule, which the browser would skip", async () => {
    const result = await run(`test "The server requires a code"
  given journey = none
  set business_structure = "Partnership"
  set registered_agent = "Jane Doe"
  expect server_code required
  submit
  expect refused
  expect error on server_code: required`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("withholds a hidden answer excluded from the submission", async () => {
    const result = await run(`test "A sole proprietor never sees the agent"
  given journey = none
  set business_structure = "Sole proprietorship"
  expect registered_agent hidden
  expect registered_agent optional
  expect server_code optional
  set registered_agent = "Nobody"
  submit
  expect accepted
  expect registered_agent withheld`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("words a message in the given locale from the form's catalog", async () => {
    const result = await run(`test "French"
  given journey = none
  given locale = "fr-CA"
  set business_structure = "Partnership"
  submit
  expect message on registered_agent = "Répondez"`);
    expect(trouble(result)).toEqual([]);
  });

  it("holds a data-source choice to the options a scenario gives", async () => {
    const result = await run(`test "Province from the snapshot"
  given journey = none
  given options for province = ("ON", "QC")
  set province = "BC"
  submit
  expect refused
  expect error on province: option.notAllowed
  set province = "ON"
  submit
  expect accepted`);
    expect(trouble(result)).toEqual([]);
  });
});

describe("the kernel driver: journeys", () => {
  it("follows a route to an exit page, which ends the path and refuses the submission", async () => {
    const result = await run(`test "STOP ends at the exit page"
  set business_structure = "STOP"
  expect page = intro
  continue
  expect page = stop
  expect path ends at stop
  expect path = (intro, stop)
  continue
  expect page = stop
  submit
  expect refused`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("stays on a page whose check blocks, and jumps no further than the frontier", async () => {
    const result = await run(`test "Continue off a page with errors stays"
  set business_structure = "Partnership"
  continue
  expect page = agent
  continue
  expect page = agent
  expect error on registered_agent: required
  expect error on server_code: required
  go to details
  expect page = agent
  set registered_agent = "Jane"
  set server_code = "S"
  continue
  expect page = details
  back
  expect page = agent
  go to details
  expect page = details
  go to intro
  expect page = intro
  expect path = (intro, agent, details)
  expect path ends`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("moves back onto the path when an answer takes the current page off it", async () => {
    // As the runtime's reconcile does: the last page on the new path that comes before the
    // page left in the journey's order, here the exit page declared before `agent`.
    const result = await run(`test "Rerouted"
  set business_structure = "Partnership"
  continue
  expect page = agent
  set business_structure = "STOP"
  expect page = stop
  expect agent off path
  set business_structure = "Partnership"
  expect page = intro
  expect path = (intro, agent, details)`);
    expect(trouble(result)).toEqual([]);
  });

  it("refuses a journey the form does not have at start", async () => {
    const result = await run(`test "Nope"
  given journey = nope
  expect accepted`);
    expect(result).toMatchObject({ status: "error", reason: "scenario.unknownJourney", steps: [] });
  });
});

describe("the kernel driver: what this side cannot replay", () => {
  it("skips an expectation on a component whose rule reads `host.`", async () => {
    const result = await run(`test "A host rule is the browser's"
  given journey = none
  expect role_note visible`);
    expect(result.steps).toEqual([{ line: 3, status: "skipped", code: "unreplayable.host" }]);
    expect(result).toMatchObject({ status: "skipped", reason: "unreplayable.host" });
  });

  it("replays a scenario that gives a `host.` value: the givens are the runs' host context", async () => {
    const result = await run(`test "A host given is replayed"
  given journey = none
  given host.role = "admin"
  expect role_note visible
  submit
  expect accepted`);
    expect(result.status).toBe("passed");
    expect(trouble(result)).toEqual([]);
    // A key no given set reads as no answer, as it does in the browser: the note stays hidden.
    const other = await run(`test "Another host key"
  given journey = none
  given host.region = "north"
  expect role_note hidden`);
    expect(other.status).toBe("passed");
    expect(trouble(other)).toEqual([]);
  });

  it("nests a dotted host given and works out a calculation reading `host.` against it", async () => {
    const hostForm = {
      id: "host-fixture",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "unit_note", type: "text", configuration: {}, rules: { visibleWhen: 'host.org.unit = "tax"' } },
            { id: "who", type: "text", configuration: {}, rules: { value: "host.role" } }
          ]
        }
      }
    } as unknown as FormDefinition;
    const driver = createFormTestKernelDriver(hostForm, { host });
    await driver.start([
      { kind: "given", key: "host", name: "org.unit", value: "tax", line: 2 },
      { kind: "given", key: "host", name: "role", value: "clerk", line: 3 }
    ]);
    const snapshot = await driver.snapshot();
    expect(snapshot.unreplayable ?? {}).toEqual({});
    expect(snapshot.effective.unit_note?.visible).toBe(true);
    expect(snapshot.values.who).toBe("clerk");
    // With no host given the same form's host rules are not this side's.
    const bare = createFormTestKernelDriver(hostForm, { host });
    await bare.start([]);
    expect((await bare.snapshot()).unreplayable).toEqual({ unit_note: "unreplayable.host", who: "unreplayable.host" });
  });

  it("ends a clock-reading form's scenario with no day as `scenario.clockUnset`, as the browser's side does, and judges it with one", async () => {
    const without = await run(`test "No day"
  expect late_fee visible`, clockDefinition);
    expect(without).toMatchObject({ status: "error", reason: "scenario.clockUnset", steps: [] });
    const withDay = await run(`test "A day"
  given today = @"2026-03-01"
  expect late_fee visible`, clockDefinition);
    expect(withDay.status).toBe("passed");
  });
});

describe("the kernel driver: rows and calculations", () => {
  it("adds and removes rows, posting an empty row as a row", async () => {
    const result = await run(`test "Rows"
  given journey = none
  add row to items with qty = 2
  add row to items
  expect rows of items = 2
  expect items[0].qty = 2
  expect items[1].qty empty
  remove row 0 of items
  expect rows of items = 1
  expect items[0].qty empty
  set items[2].qty = 7
  expect rows of items = 3
  expect items[2].qty = 7`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("reads a calculation the kernel works out, by value and by formula", async () => {
    const result = await run(`test "Total"
  given journey = none
  set subtotal = 5
  expect total = 10
  expect total = subtotal * 2
  expect total != 11`);
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("refuses a row action on a path that is no section's as a coded refusal", async () => {
    const result = await run(`test "Not a section"
  given journey = none
  add row to subtotal
  expect rows of items = 0`);
    expect(result.status).toBe("error");
    expect(result.steps).toEqual([
      { line: 3, status: "error", code: "action.refused", params: { action: "addRow", reason: "unknownCollection", path: "subtotal" } }
    ]);
  });

  it("refuses removing a row that is not there, with the index and the count", async () => {
    const result = await run(`test "No such row"
  given journey = none
  remove row 4 of items
  expect rows of items = 0`);
    expect(result.status).toBe("error");
    expect(result.steps[0]).toEqual({
      line: 3,
      status: "error",
      code: "action.refused",
      params: { action: "removeRow", reason: "rowOutOfRange", path: "items", index: 4, count: 0 }
    });
  });
});

describe("the kernel driver: the snapshot", () => {
  it("reports the required map the kernel's fold gives over the same inputs", async () => {
    const driver = createFormTestKernelDriver(definition, { host });
    await driver.start([]);
    await driver.set("business_structure", "Partnership");
    await driver.addRow("items", { qty: 3 });
    const snapshot = await driver.snapshot();

    // The fold, independently: the definition compiled as the run compiles it, the answers
    // partitioned as the run partitions them, the hidden-required policy applied.
    const prepared = kernelPrepareDefinition(root, journey, undefined, "fail", undefined, formulaFunctionSignatures());
    const values = kernelPartitionValues({ business_structure: "Partnership", items: [{ qty: 3 }] }, prepared.root, prepared).known;
    const fold = kernelFoldSubmission(
      prepared.root,
      values,
      kernelIsJourney(prepared.journey) ? prepared.journey : undefined,
      { regexCache: { refuseRisky: true } },
      prepared
    );
    const expected: Record<string, boolean> = {};
    for (const id of Object.keys(fold.required)) {
      expected[id] = fold.required[id] === true && fold.effective[id]?.requiredApplies === true;
    }
    expect(snapshot.required).toEqual(expected);
    expect(snapshot.required).toMatchObject({ registered_agent: true, server_code: true, business_structure: false });
    expect(snapshot.values).toEqual({ ...fold.idValues });
    expect(snapshot.page).toBe("intro");
    expect(snapshot.trace?.pages).toEqual(["intro", "agent", "details"]);
    expect(snapshot.rows).toEqual({ items: 1 });
    expect(snapshot.byPath).toMatchObject({ business_structure: "Partnership", "items[0].qty": 3 });
    // Nothing checked yet: no errors on show and no verdict.
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.verdict).toBeUndefined();
    // The `server` rule is this side's; the `host.` one is not.
    expect(snapshot.unreplayable).toEqual({ role_note: "unreplayable.host" });
    expect(driver.componentIdOf("items[0].qty")).toBe("qty");
    expect(driver.componentIdOf("items")).toBe("items");
    expect(driver.componentIdOf("nowhere")).toBeUndefined();
    expect(driver.typeOf?.("items")).toBe("repeatingSection");
  });

  it("evaluates a formula over the settled view with the kernel's evaluator", async () => {
    const driver = createFormTestKernelDriver(definition, { host });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 1 }]);
    await driver.set("subtotal", 4);
    const snapshot = await driver.snapshot();
    const [scenario] = scenarios(`test "x"
  expect total + subtotal = 12`);
    const formula = scenario?.steps[0];
    expect(formula?.kind).toBe("expectFormula");
    if (formula?.kind === "expectFormula") {
      expect(driver.evaluate(formula.expression, snapshot.values)).toBe(true);
    }
  });
});

describe("the kernel driver: a checkbox group's stored shape", () => {
  const groupForm = {
    id: "group-fixture",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "topics",
            type: "checkboxes",
            configuration: { options: [{ value: "news" }, { value: "offers" }, { value: "events" }] }
          },
          { id: "regions", type: "checkboxes", configuration: { data: { sourceId: "regions" } } }
        ]
      }
    }
  } as unknown as FormDefinition;
  const none = { kind: "given", key: "journey", value: "none", line: 1 } as const;

  it("stores every inline option, the unpicked ones false, as the renderer does", async () => {
    const driver = createFormTestKernelDriver(groupForm, { host });
    await driver.start([none]);
    await driver.set("topics", ["news", "events"]);
    expect((await driver.snapshot()).byPath.topics).toEqual({ news: true, offers: false, events: true });
    await driver.set("topics", []);
    expect((await driver.snapshot()).byPath.topics).toEqual({ news: false, offers: false, events: false });
    expect(driver.typeOf?.("topics")).toBe("checkboxes");
  });

  it("ticks a picked value outside the options too, after the options", async () => {
    const driver = createFormTestKernelDriver(groupForm, { host });
    await driver.start([none]);
    await driver.set("topics", ["news", "other"]);
    expect((await driver.snapshot()).byPath.topics).toEqual({ news: true, offers: false, events: false, other: true });
  });

  it("stores the options a `given options for` gave a source-backed group", async () => {
    const driver = createFormTestKernelDriver(groupForm, { host });
    await driver.start([none, { kind: "given", key: "options", path: "regions", values: ["east", "west"], line: 2 }]);
    await driver.set("regions", ["west"]);
    expect((await driver.snapshot()).byPath.regions).toEqual({ east: false, west: true });
  });

  it("carries the same record into the submitted answers", async () => {
    const result = await run(
      `test "submitted"
  given journey = none
  set topics = ("news")
  submit
  expect accepted
  expect submitted topics = ("news")`,
      groupForm
    );
    expect(trouble(result)).toEqual([]);
    expect(result.status).toBe("passed");
  });
});

describe("the kernel driver: the skip reasons of rules it leaves unevaluated", () => {
  const reasonsForm = {
    id: "reasons-fixture",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "base", type: "number", configuration: {} },
          { id: "flag", type: "checkbox", configuration: {} },
          { id: "maybe", type: "number", configuration: { hiddenValueBehavior: "exclude-from-submission" }, rules: { visibleWhen: "flag = true" } },
          { id: "doubled", type: "number", configuration: {}, rules: { value: "maybe * 2" } },
          { id: "browser_note", type: "text", configuration: {}, rules: { visibleWhen: { formula: 'base = 1', run: "browser" } } },
          { id: "host_note", type: "text", configuration: {}, rules: { visibleWhen: 'host.role = "admin"' } },
          { id: "browser_total", type: "number", configuration: {}, rules: { value: { formula: "base + 1", run: "browser" } } }
        ]
      }
    }
  } as unknown as FormDefinition;
  const none = { kind: "given", key: "journey", value: "none", line: 1 } as const;

  it("names a browser-scoped rule `unreplayable.browser` and a host one `unreplayable.host`", async () => {
    const driver = createFormTestKernelDriver(reasonsForm, { host });
    await driver.start([none]);
    const snapshot = await driver.snapshot();
    expect(snapshot.unreplayable).toMatchObject({ browser_note: "unreplayable.browser", host_note: "unreplayable.host" });
  });

  it("names a calculation kept as sent `unreplayable.clientDerived`, once the run says so", async () => {
    const driver = createFormTestKernelDriver(reasonsForm, { host });
    await driver.start([none]);
    // `maybe` is unanswered and may be withheld (hidden until `flag` is ticked, then left out), so the server cannot
    // work `doubled` out: it keeps what was sent.
    await driver.set("doubled", 10);
    await driver.submit();
    const snapshot = await driver.snapshot();
    expect(snapshot.unreplayable?.doubled).toBe("unreplayable.clientDerived");
  });

  it("skips an expectation on it with that reason", async () => {
    const result = await run(
      `test "kept as sent"
  given journey = none
  set doubled = 10
  submit
  expect doubled = 10`,
      reasonsForm
    );
    expect(result.steps.at(-1)).toEqual({ line: 5, status: "skipped", code: "unreplayable.clientDerived" });
  });

  it("skips an expectation on a browser-scoped field with its own reason", async () => {
    const result = await run(
      `test "browser"
  given journey = none
  expect browser_note hidden`,
      reasonsForm
    );
    expect(result.steps.at(-1)).toEqual({ line: 3, status: "skipped", code: "unreplayable.browser" });
  });
});

describe("the kernel driver: start errors and coded refusals", () => {
  const brokenForm = {
    ...definition,
    root: {
      ...root,
      children: {
        content: [
          ...(root.children?.content ?? []),
          { id: "broken_calc", type: "number", configuration: {}, rules: { value: "nosuch(subtotal)" } }
        ]
      }
    }
  } as unknown as FormDefinition;

  it("a definition whose formulas do not compile ends the start as scenario.formulaInvalid, with code and where", async () => {
    const result = await run(`test "Broken"
  given journey = none
  expect subtotal empty`, brokenForm);
    expect(result).toMatchObject({ status: "error", reason: "scenario.formulaInvalid", steps: [] });
    const problems = (result.params as { problems: Array<{ code: string; where: string }> }).problems;
    expect(problems[0]).toEqual({ code: expect.any(String), where: "rules:broken_calc:value" });
    expect(Object.keys(problems[0]!).sort()).toEqual(["code", "where"]);
  });

  it("the formula check comes after the clock check and before a host skip", async () => {
    const clocked = {
      ...clockDefinition,
      root: {
        ...clockDefinition.root,
        children: { content: [...(clockDefinition.root.children?.content ?? []), { id: "bad", type: "number", configuration: {}, rules: { value: "nosuch(late_fee)" } }] }
      }
    } as unknown as FormDefinition;
    const unset = await run(`test "no day"
  expect late_fee hidden`, clocked);
    expect(unset.reason).toBe("scenario.clockUnset");
    const given = await run(`test "host and broken"
  given today = "2026-02-01"
  given host.role = "admin"
  expect late_fee visible`, clocked);
    expect(given.reason).toBe("scenario.formulaInvalid");
  });

  it("the first bad given in source order is reported", async () => {
    const journeyFirst = await run(`test "journey first"
  given journey = elsewhere
  given options for subtotal = ("1")`);
    expect(journeyFirst).toMatchObject({ status: "error", reason: "scenario.unknownJourney", params: { journey: "elsewhere" } });
    const optionsFirst = await run(`test "options first"
  given options for subtotal = ("1")
  given journey = elsewhere`);
    expect(optionsFirst).toMatchObject({ status: "error", reason: "scenario.badGiven", params: { given: "options", path: "subtotal" } });
  });

  it("row actions come back as refusals with the reason and what it is about", async () => {
    const driver = createFormTestKernelDriver(definition, { host });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    expect(await driver.addRow("subtotal")).toEqual({ refused: "unknownCollection", params: { path: "subtotal" } });
    expect(await driver.removeRow("items", 0)).toEqual({ refused: "rowOutOfRange", params: { path: "items", index: 0, count: 0 } });
    expect(await driver.addRow("items", { qty: 1 })).toBeUndefined();
    expect(await driver.removeRow("items", 0)).toBeUndefined();
    expect((await driver.snapshot()).rows.items).toBe(0);
  });

  it("a section that does not allow adding or removing refuses with the operation", async () => {
    const locked = {
      ...definition,
      root: {
        ...root,
        children: {
          content: [
            {
              id: "items",
              type: "repeatingSection",
              configuration: {},
              collection: { collectionPath: "items", operations: { add: false, remove: false } },
              children: { content: [{ id: "qty", type: "number", configuration: {} }] }
            }
          ]
        }
      }
    } as unknown as FormDefinition;
    const driver = createFormTestKernelDriver(locked, { host });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    expect(await driver.addRow("items")).toEqual({ refused: "operations.add", params: { path: "items" } });
    expect(await driver.removeRow("items", 0)).toEqual({ refused: "operations.remove", params: { path: "items" } });
  });

  it("the snapshot lists every page of the journey it runs, and none without one", async () => {
    const driver = createFormTestKernelDriver(definition, { host });
    await driver.start([]);
    expect((await driver.snapshot()).pages).toEqual(["intro", "stop", "agent", "details"]);
    const flat = createFormTestKernelDriver(definition, { host });
    await flat.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    expect((await flat.snapshot()).pages).toBeUndefined();
  });
});
