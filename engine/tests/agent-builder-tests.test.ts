import { afterEach, describe, expect, it, vi } from "vitest";

import { agentWords } from "../form-engine/agent/builder/agent-texts-en.js";
import type { TestsChunk } from "../form-engine/agent/builder/host.js";
import { createTestsRunner } from "../form-engine/builder/form-tests/tests-runner.js";
import { createTestsNaming, createTestsWords } from "../form-engine/builder/form-tests/tests-words.js";
import type { TestsEntryModel, TestsRunOutcome, TestsRunner, TestsRunnerOptions } from "../form-engine/builder/form-tests/tests-model.js";
import type { FormTestConfiguration } from "../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import { agentBuilder, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * The builder's tests tools: write_test, list_tests and run_tests round trips over the real runner (the
 * tests chunk's modules, imported directly, as host.loadTests would hand them), the runner wired
 * as the Tests panel wires it, failures worded with the panel's own words, an unsaved block run
 * without saving, the refusals, the tests feature, the time budget, cancellation, one run at a
 * time and a chunk that does not load.
 */

const REAL_CHUNK: TestsChunk = { createTestsRunner, createTestsWords, createTestsNaming };

const realTests = (): (() => Promise<TestsChunk>) => async () => REAL_CHUNK;

const PASSING = 'test "Sales leaves the message optional"\n  set topic = "sales"\n  expect message optional\n';
const FAILING = 'test "Sales makes the message required"\n  set topic = "sales"\n  expect message required\n';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A chunk whose runner runs nothing until released or cancelled: one result per `finish(id)`, the rest pending. */
function gatedChunk() {
  const state = {
    entered: 0,
    cancels: 0,
    parses: [] as Array<FormTestConfiguration | undefined>,
    finish: undefined as ((ids: readonly string[]) => void) | undefined
  };
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const chunk: TestsChunk = {
    createTestsWords,
    createTestsNaming,
    createTestsRunner(options: TestsRunnerOptions): TestsRunner {
      const inner = createTestsRunner(options);
      let settle: ((outcome: TestsRunOutcome) => void) | undefined;
      let current: readonly TestsEntryModel[] = [];
      const finished = new Map<string, { name: string; status: "passed"; steps: [] }>();
      const outcome = (cancelled: boolean): TestsRunOutcome => ({
        cancelled,
        results: new Map(finished),
        summary: { total: current.length, passed: finished.size, failed: 0, skipped: 0, error: 0, invalid: 0 }
      });
      state.finish = (ids) => {
        for (const id of ids) {
          const entry = current.find((one) => one.id === id);
          finished.set(id, { name: entry?.name ?? id, status: "passed", steps: [] });
        }
        if (finished.size === current.filter((entry) => entry.scenario !== undefined).length) {
          settle?.(outcome(false));
        }
      };
      return {
        parse(tests) {
          state.parses.push(tests);
          return inner.parse(tests);
        },
        replay: (scenario, through) => inner.replay(scenario, through),
        cancel() {
          state.cancels += 1;
          settle?.(outcome(true));
        },
        run(entries) {
          current = entries;
          state.entered += 1;
          enteredResolve?.();
          return new Promise<TestsRunOutcome>((resolve) => {
            settle = resolve;
          });
        }
      };
    }
  };
  return { chunk, state, entered };
}

function twoTests(): FormTestConfiguration {
  return {
    scenarios: [
      { id: "test-1", source: 'test "Other topic needs a message"\n  set topic = "other"\n  expect message required\n' },
      { id: "test-2", source: PASSING }
    ]
  };
}

describe("write_test, list_tests and run_tests", () => {
  it("writes a test in one undo step, lists it, and runs it to a pass and to a failure", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    const written = okOf(await builder.execute("write_test", { source: PASSING }));
    expect(written).toMatchObject({ id: "test-2", name: "Sales leaves the message optional", replaced: false, dryRun: false, refs: ["topic", "message"], unknownRefs: [] });
    expect(written.undo).toEqual({ steps: 1, ownSteps: 1, canUndo: true, canRedo: false });
    expect(written.next).toEqual(['run_tests { ids: ["test-2"] }']);
    expect(builder.controller.tests()?.scenarios.map((entry) => entry.id)).toEqual(["test-1", "test-2"]);

    const listed = okOf(await builder.execute("list_tests", {}));
    expect(listed).toMatchObject({ total: 2, count: 2, featureOn: true });
    const second = (listed.tests as Array<Record<string, unknown>>)[1];
    expect(second).toMatchObject({ id: "test-2", name: "Sales leaves the message optional", line: 1, steps: 2, refs: ["topic", "message"], valid: true, problems: [], source: PASSING });

    const passed = okOf(await builder.execute("run_tests", { ids: ["test-2"] }));
    expect(passed.summary).toMatchObject({ total: 1, passed: 1, failed: 0, notRun: 0 });
    expect(passed.results).toEqual([{ id: "test-2", name: "Sales leaves the message optional", status: "passed", steps: { total: 2, passed: 2, failed: 0, skipped: 0 }, failures: [] }]);
    expect(passed).toMatchObject({ pending: [], partial: false, draftsExcluded: [] });

    // Replace it with a failing block, then run everything.
    okOf(await builder.execute("write_test", { id: "test-2", source: FAILING }));
    const ran = okOf(await builder.execute("run_tests", {}));
    expect(ran.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const failed = (ran.results as Array<Record<string, unknown>>).find((row) => row.id === "test-2") as Record<string, unknown>;
    expect(failed.status).toBe("failed");
    expect(failed.firstFailure).toMatchObject({ line: 3, text: "expect message required", code: "expect.required", expected: true, actual: false });
    expect(ran.next).toBeDefined();

    // The last run shows on list_tests.
    const after = okOf(await builder.execute("list_tests", { ids: ["test-2"], includeSource: false }));
    const row = (after.tests as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(row.source).toBeUndefined();
    expect(row.lastRun).toMatchObject({ status: "failed" });
  });

  it("wires the runner as the panel does: parse takes { scenarios }, failures read the panel's words and the source line", async () => {
    const parses: unknown[] = [];
    const chunk: TestsChunk = {
      ...REAL_CHUNK,
      createTestsRunner(options) {
        const runner = createTestsRunner(options);
        return { ...runner, parse: (tests) => (parses.push(tests), runner.parse(tests)) };
      }
    };
    const builder = agentBuilder({ host: { loadTests: async () => chunk } });
    const result = okOf(await builder.execute("run_tests", { source: FAILING }));
    expect(parses).toEqual([{ scenarios: [{ id: "unsaved", source: FAILING }] }]);
    const row = (result.results as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(row.id).toBeUndefined();
    expect(row.name).toBe("Sales makes the message required");

    // The same run, made by hand: the message is createTestsWords(...).step(step, scenario).
    const runner = createTestsRunner({ definition: () => builder.host.definition(), root: () => builder.controller.snapshot() });
    const [entry] = runner.parse({ scenarios: [{ id: "x", source: FAILING }] });
    const outcome = await runner.run([entry as TestsEntryModel]);
    const step = outcome.results.get("x")?.steps.find((one) => one.status === "failed");
    const words = createTestsWords({ naming: createTestsNaming(builder.controller.snapshot(), builder.host.definition()), text: builder.host.words().options() });
    const firstFailure = row.firstFailure as Record<string, unknown>;
    expect(firstFailure.message).toBe(words.step(step as NonNullable<typeof step>, (entry as TestsEntryModel).scenario));
    expect(firstFailure.message).not.toBe("");
    expect(firstFailure.text).toBe(FAILING.split("\n")[2]?.trim());

    // ids run the saved block filtered to them.
    parses.length = 0;
    okOf(await builder.execute("run_tests", { ids: ["test-1"] }));
    expect(parses).toEqual([{ scenarios: [builder.controller.tests()?.scenarios[0]] }]);
  });

  it("wires the runner as the panel does: the plugin functions, the plugins' signatures only, the committed definition, the words' text", async () => {
    const plugin = { name: "double", min: 1, max: 1 };
    const sources = { has: () => false, ids: () => [], load: async () => ({ items: [] }) };
    const seen: { options?: TestsRunnerOptions; text?: unknown } = {};
    const chunk: TestsChunk = {
      ...REAL_CHUNK,
      createTestsRunner(options) {
        seen.options = options;
        return createTestsRunner(options);
      },
      createTestsWords(options) {
        seen.text = options.text;
        return createTestsWords(options);
      }
    };
    const builder = agentBuilder({
      host: {
        loadTests: async () => chunk,
        signatures: () => [...formulaFunctionSignatures(), plugin],
        formulaFunctions: () => ({ table: () => [], signatures: () => [plugin], functions: () => ({ double: (args: unknown[]) => Number(args[0]) * 2 }) }),
        dataSources: () => sources as never
      }
    });
    const block = 'test "A plugin function runs"\n  expect double(2) = 4\n';
    const result = okOf(await builder.execute("run_tests", { source: block }));
    expect(result.summary).toMatchObject({ total: 1, passed: 1, failed: 0, error: 0, invalid: 0 });
    const options = seen.options as TestsRunnerOptions;
    // The plugins' own signatures: the runner adds the built-ins itself.
    expect(options.signatures?.()).toEqual([plugin]);
    expect(Object.keys(options.functions?.() ?? {})).toEqual(["double"]);
    expect(options.definition()).toEqual(builder.host.definition());
    expect(options.root()).toEqual(builder.controller.snapshot());
    // The host's data sources, as the panel hands them.
    expect(options.dataSources?.()).toBe(sources);
    // The words read the tools' own text options (host.words() widened with the agent table).
    expect(seen.text).toEqual(agentWords(builder.host.words()).options());
  });

  it("runs an unsaved block without saving anything", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    const before = builder.controller.tests();
    const revision = builder.registration.revision();
    okOf(await builder.execute("run_tests", { source: PASSING }));
    expect(builder.controller.tests()).toEqual(before);
    expect(builder.controller.canUndo()).toBe(false);
    expect(builder.registration.revision()).toBe(revision);
  });

  it("removes a test in one undo step and says how many remain", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ tests: twoTests(), ui: stub });
    const removed = okOf(await builder.execute("remove_test", { id: "test-1" }));
    expect(removed).toMatchObject({ id: "test-1", name: "Other topic needs a message", remaining: 1 });
    expect(removed.undo).toMatchObject({ steps: 1, canUndo: true });
    expect(stub.callsOf("announce")).toContainEqual(["Assistant removed the test Other topic needs a message"]);
    builder.controller.undo();
    expect(builder.controller.tests()?.scenarios.map((entry) => entry.id)).toEqual(["test-1", "test-2"]);
    // The last one goes: the block goes with it.
    const one = agentBuilder();
    okOf(await one.execute("remove_test", { id: "test-1" }));
    expect(one.controller.tests()).toBeUndefined();
  });

  it("parses only on dryRun, and announces a real write", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const dry = okOf(await builder.execute("write_test", { source: PASSING, dryRun: true }));
    expect(dry).toMatchObject({ id: "test-2", dryRun: true });
    expect((dry.undo as { steps: number }).steps).toBe(0);
    expect(builder.controller.tests()?.scenarios).toHaveLength(1);
    okOf(await builder.execute("write_test", { source: PASSING }));
    expect(stub.callsOf("announce")).toContainEqual(["Assistant wrote the test Sales leaves the message optional"]);
  });

  it("drops a replaced test's last run: it described the old source", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    okOf(await builder.execute("write_test", { source: FAILING }));
    expect(okOf(await builder.execute("run_tests", { ids: ["test-2"] })).summary).toMatchObject({ failed: 1 });
    const failedRow = (okOf(await builder.execute("list_tests", { ids: ["test-2"] })).tests as Array<Record<string, unknown>>)[0];
    expect(failedRow?.lastRun).toMatchObject({ status: "failed" });
    okOf(await builder.execute("write_test", { id: "test-2", source: PASSING }));
    const replaced = (okOf(await builder.execute("list_tests", { ids: ["test-2"] })).tests as Array<Record<string, unknown>>)[0];
    expect(replaced).toMatchObject({ id: "test-2", name: "Sales leaves the message optional" });
    expect(replaced?.lastRun).toBeUndefined();
    // The other test's last run stays; a dry run drops nothing.
    okOf(await builder.execute("run_tests", {}));
    okOf(await builder.execute("write_test", { id: "test-2", source: FAILING, dryRun: true }));
    expect((okOf(await builder.execute("list_tests", { ids: ["test-2"] })).tests as Array<Record<string, unknown>>)[0]?.lastRun).toMatchObject({ status: "passed" });
  });

  it("shows no lastRun from a run that read a source the test no longer holds: a write during the run, the person's edit, an Undo", async () => {
    // A write_test that lands while the run waits for its chunk (a run never joins the write chain).
    let hold = false;
    let release: (() => void) | undefined;
    const builder = agentBuilder({
      host: {
        loadTests: () =>
          hold
            ? new Promise<TestsChunk>((resolve) => {
                release = () => resolve(REAL_CHUNK);
              })
            : Promise.resolve(REAL_CHUNK)
      }
    });
    const lastRunOf = async (id: string): Promise<unknown> =>
      (okOf(await builder.execute("list_tests", { ids: [id] })).tests as Array<Record<string, unknown>>)[0]?.lastRun;
    okOf(await builder.execute("write_test", { source: FAILING }));
    hold = true;
    const run = builder.execute("run_tests", { ids: ["test-2"] });
    await vi.waitFor(() => expect(release).toBeDefined());
    hold = false;
    expect(okOf(await builder.execute("write_test", { id: "test-2", source: PASSING })).undo).toMatchObject({ steps: 1 });
    release?.();
    expect(okOf(await run).summary).toMatchObject({ failed: 1 });
    const replaced = (okOf(await builder.execute("list_tests", { ids: ["test-2"] })).tests as Array<Record<string, unknown>>)[0];
    expect(replaced).toMatchObject({ id: "test-2", name: "Sales leaves the message optional" });
    expect(replaced?.lastRun).toBeUndefined();

    // A run of the stored source shows, as { status, at } only.
    okOf(await builder.execute("run_tests", { ids: ["test-2"] }));
    const shown = await lastRunOf("test-2");
    expect(shown).toEqual({ status: "passed", at: expect.any(Number) });

    // The person's Undo brings the failing block back: the passing run does not describe it.
    builder.controller.undo();
    expect(builder.controller.tests()?.scenarios.find((entry) => entry.id === "test-2")?.source).toBe(FAILING);
    expect(await lastRunOf("test-2")).toBeUndefined();

    // The person's own edit in the Tests panel (one setTests) replaces the block under the run.
    okOf(await builder.execute("run_tests", { ids: ["test-2"] }));
    expect(await lastRunOf("test-2")).toMatchObject({ status: "failed" });
    builder.controller.setTests({ scenarios: (builder.controller.tests()?.scenarios ?? []).map((entry) => (entry.id === "test-2" ? { id: entry.id, source: PASSING } : { ...entry })) });
    expect(await lastRunOf("test-2")).toBeUndefined();
  });

  it("remove_test forgets the test's last run: an Undo that brings it back shows none", async () => {
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: realTests() } });
    okOf(await builder.execute("run_tests", {}));
    okOf(await builder.execute("remove_test", { id: "test-2" }));
    builder.controller.undo();
    const rows = okOf(await builder.execute("list_tests", {})).tests as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.id)).toEqual(["test-1", "test-2"]);
    expect(rows.map((row) => row.lastRun)).toEqual([expect.objectContaining({ status: "passed" }), undefined]);
  });

  it("records an invalid saved block's run as lastRun { status: invalid }", async () => {
    const builder = agentBuilder({ tests: { scenarios: [{ id: "test-1", source: 'test "Bad"\n  set x to 1\n' }] }, host: { loadTests: realTests() } });
    const ran = okOf(await builder.execute("run_tests", {}));
    expect(ran.summary).toMatchObject({ total: 1, invalid: 1 });
    const row = (okOf(await builder.execute("list_tests", {})).tests as Array<Record<string, unknown>>)[0];
    expect(row?.lastRun).toEqual({ status: "invalid", at: expect.any(Number) });
  });

  it("warns about refs that name nothing, and saves the test anyway", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("write_test", { source: 'test "Ghost"\n  set ghost = "x"\n  expect topic visible\n' }));
    expect(result.unknownRefs).toEqual(["ghost"]);
    expect(result.warnings).toEqual(["unknown-ref: the test names ghost, which is no component id or value path; saved anyway."]);
    expect(builder.controller.tests()?.scenarios).toHaveLength(2);
  });
});

describe("refusals", () => {
  it("test-parse-error on a source that does not parse, nothing saved; and on run_tests { source } with no block", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    const bad = refusalOf(await builder.execute("write_test", { source: 'test "Bad"\n  set topic to "other"\n' }));
    expect(bad.code).toBe("test-parse-error");
    expect(bad.retryable).toBe(false);
    expect(bad.hint).toBe("Fix the lines named; nothing was saved. list_tests.syntaxHint shows the statements.");
    expect((bad.details?.problems as Array<{ line: number }>)[0]?.line).toBe(2);
    expect(builder.controller.tests()?.scenarios).toHaveLength(1);
    expect(builder.controller.canUndo()).toBe(false);

    const twice = refusalOf(await builder.execute("write_test", { source: `${PASSING}${FAILING}` }));
    expect(twice.code).toBe("test-parse-error");
    expect((twice.details?.problems as Array<{ code: string }>).map((problem) => problem.code)).toContain("stepOutsideTest");

    const empty = refusalOf(await builder.execute("run_tests", { source: "   \n" }));
    expect(empty.code).toBe("test-parse-error");
  });

  it("duplicate-test-name without an id, unknown-test for ids that are not there", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    const duplicate = refusalOf(await builder.execute("write_test", { source: 'test "Other topic needs a message"\n  set topic = "other"\n' }));
    expect(duplicate.code).toBe("duplicate-test-name");
    expect(duplicate.details).toEqual({ name: "Other topic needs a message", id: "test-1" });
    expect(duplicate.hint).toBe('Pass id: "test-1" to replace that test, or change the name.');

    for (const [tool, input] of [
      ["write_test", { id: "test-9", source: PASSING }],
      ["remove_test", { id: "test-9" }],
      ["run_tests", { ids: ["test-9"] }],
      ["list_tests", { ids: ["test-9"] }]
    ] as const) {
      const refused = refusalOf(await builder.execute(tool, input));
      expect(refused.code, tool).toBe("unknown-test");
      expect(refused.details).toEqual({ id: "test-9", known: ["test-1"] });
      expect(refused.hint).toBe("Call list_tests.");
    }
    expect(refusalOf(await builder.execute("run_tests", { ids: ["test-1"], source: PASSING })).code).toBe("bad-input");
  });

  it("feature-off on write_test, remove_test and run_tests; list_tests still lists and says featureOn: false", async () => {
    const builder = agentBuilder({ featureOn: { tests: false }, host: { loadTests: realTests() } });
    for (const [tool, input] of [
      ["write_test", { source: PASSING }],
      ["remove_test", { id: "test-1" }],
      ["run_tests", {}]
    ] as const) {
      const refused = refusalOf(await builder.execute(tool, input));
      expect(refused.code, tool).toBe("feature-off");
      expect(refused.details).toEqual({ feature: "tests" });
    }
    const listed = okOf(await builder.execute("list_tests", {}));
    expect(listed.featureOn).toBe(false);
    expect(listed.total).toBe(1);
  });

  it("write_test and remove_test yield to the person: a Form-panel draft, a designer", async () => {
    const builder = agentBuilder();
    builder.controller.setDraftProperty("root", "title", "Draft title");
    const draft = refusalOf(await builder.execute("write_test", { source: PASSING }));
    expect(draft.code).toBe("unsaved-draft");
    expect(draft.details).toMatchObject({ reason: "draft", componentId: "root" });
    expect(refusalOf(await builder.execute("remove_test", { id: "test-1" })).code).toBe("unsaved-draft");
    expect(builder.controller.tests()?.scenarios).toHaveLength(1);

    const designer = agentBuilder({ ui: uiStub({ mode: "pdf" }) });
    expect(refusalOf(await designer.execute("write_test", { source: PASSING })).code).toBe("wrong-mode");
    // A dry run writes nothing, so it is not held back.
    expect(okOf(await designer.execute("write_test", { source: PASSING, dryRun: true })).dryRun).toBe(true);
  });
});

describe("run_tests: budget, cancellation, one run at a time, the chunk", () => {
  it("stops at timeBudgetMs and reports what did not run as pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gated = gatedChunk();
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => gated.chunk } });
    const call = builder.execute("run_tests", { timeBudgetMs: 1000 });
    await gated.entered;
    gated.state.finish?.(["test-1"]);
    await vi.advanceTimersByTimeAsync(1000);
    const result = okOf(await call);
    expect(gated.state.cancels).toBe(1);
    expect(result.pending).toEqual(["test-2"]);
    expect(result.partial).toBe(true);
    expect(result.summary).toMatchObject({ total: 2, passed: 1, notRun: 1 });
    expect((result.results as Array<{ status: string }>).map((row) => row.status)).toEqual(["passed", "not-run"]);
  });

  it("leaves no timer and no abort listener behind a run that finished: a later abort cancels nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gated = gatedChunk();
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => gated.chunk } });
    const controller = new AbortController();
    const call = builder.execute("run_tests", {}, { signal: controller.signal });
    await gated.entered;
    expect(vi.getTimerCount()).toBe(1);
    gated.state.finish?.(["test-1", "test-2"]);
    expect(okOf(await call)).toMatchObject({ partial: false, pending: [] });
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gated.state.cancels).toBe(0);
  });

  it("runs on the tree, definition and naming of the call: a commit while the chunk loads is not in the run", async () => {
    const seen: { options?: TestsRunnerOptions; naming?: unknown[] } = {};
    let release: (() => void) | undefined;
    const chunk: TestsChunk = {
      ...REAL_CHUNK,
      createTestsRunner(options) {
        seen.options = options;
        return createTestsRunner(options);
      },
      createTestsNaming(...args: Parameters<TestsChunk["createTestsNaming"]>) {
        seen.naming = args;
        return createTestsNaming(...args);
      }
    };
    const builder = agentBuilder({
      host: {
        loadTests: () =>
          new Promise<TestsChunk>((resolve) => {
            release = () => resolve(chunk);
          })
      }
    });
    // snapshot() shares each node's configuration with the live tree: the test keeps its own copies.
    const before = structuredClone(builder.controller.snapshot());
    const definitionBefore = structuredClone(builder.host.definition());
    const call = builder.execute("run_tests", {});
    await vi.waitFor(() => expect(release).toBeDefined());
    builder.controller.setProperty("email", "label", "E-mail address");
    expect(builder.controller.snapshot()).not.toEqual(before);
    release?.();
    okOf(await call);
    const options = seen.options as TestsRunnerOptions;
    expect(options.root()).toEqual(before);
    expect(options.definition()).toEqual(definitionBefore);
    expect(seen.naming?.[0]).toEqual(before);
    expect(seen.naming?.[1]).toEqual(definitionBefore);
  });

  it("a chunk load that never settles ends at timeBudgetMs (chunk-unavailable) or at abort (cancelled), and frees the flag", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stalled = true;
    const builder = agentBuilder({ host: { loadTests: () => (stalled ? new Promise<TestsChunk>(() => undefined) : Promise.resolve(REAL_CHUNK)) } });
    const call = builder.execute("run_tests", { timeBudgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refusalOf(await call)).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "tests" } });
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const aborted = builder.execute("run_tests", {}, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(refusalOf(await aborted).code).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);

    // The flag went with each call: the next run is not busy.
    vi.useRealTimers();
    stalled = false;
    expect(okOf(await builder.execute("run_tests", {})).summary).toMatchObject({ passed: 1 });
  });

  it("answers cancelled when the signal is aborted before the call", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    const controller = new AbortController();
    controller.abort();
    expect(refusalOf(await builder.execute("run_tests", {}, { signal: controller.signal })).code).toBe("cancelled");
  });

  it("answers cancelled, with the core hint, when the signal is aborted while the chunk loads, and never runs", async () => {
    let release: ((chunk: TestsChunk) => void) | undefined;
    let loading = false;
    let runs = 0;
    const chunk: TestsChunk = {
      ...REAL_CHUNK,
      createTestsRunner(options) {
        const runner = createTestsRunner(options);
        return {
          ...runner,
          run: (entries) => {
            runs += 1;
            return runner.run(entries);
          }
        };
      }
    };
    const builder = agentBuilder({
      host: {
        loadTests: () => {
          loading = true;
          return new Promise<TestsChunk>((resolve) => {
            release = resolve;
          });
        }
      }
    });
    const controller = new AbortController();
    const call = builder.execute("run_tests", {}, { signal: controller.signal });
    await vi.waitFor(() => expect(loading).toBe(true));
    controller.abort();
    release?.(chunk);
    const refused = refusalOf(await call);
    expect(refused.code).toBe("cancelled");
    expect(refused.hint).toBe("The call was cancelled. If stillRunning is set the action may still complete; call describe_builder before retrying.");
    expect(runs).toBe(0);
  });

  it("a reseed cancels the run in flight (partial, the rest pending, no lastRun), and its end never frees the newer run's flag", async () => {
    const gates = [gatedChunk(), gatedChunk()];
    let loads = 0;
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => (gates[Math.min(loads++, 1)] as ReturnType<typeof gatedChunk>).chunk } });
    const [old, fresh] = gates as [ReturnType<typeof gatedChunk>, ReturnType<typeof gatedChunk>];
    const first = builder.execute("run_tests", {});
    await old.entered;
    builder.registration.runtimeReplaced();
    expect(old.state.cancels).toBe(1);
    const lastRunsOfList = async (): Promise<unknown[]> =>
      (okOf(await builder.execute("list_tests", {})).tests as Array<Record<string, unknown>>).map((row) => row.lastRun);
    expect(await lastRunsOfList()).toEqual([undefined, undefined]);
    // The reseed emptied the memory, so a new run starts.
    const second = builder.execute("run_tests", {});
    await fresh.entered;
    const answered = okOf(await first);
    expect(answered).toMatchObject({ partial: true, pending: ["test-1", "test-2"], summary: { passed: 0, notRun: 2 } });
    // The newer run's cancel is in place (the next test pins the order where the old run ends last).
    expect(builder.catalogue.shared.memory.cancelRun).toEqual(expect.any(Function));
    // The old run's end left the newer run's flag alone, and wrote no lastRun.
    const third = refusalOf(await builder.execute("run_tests", {}));
    expect(third).toMatchObject({ code: "busy", details: { because: "run-tests" } });
    expect(await lastRunsOfList()).toEqual([undefined, undefined]);
    fresh.state.finish?.(["test-1", "test-2"]);
    okOf(await second);
    expect(await lastRunsOfList()).toEqual([expect.objectContaining({ status: "passed" }), expect.objectContaining({ status: "passed" })]);
  });

  it("an old run that ends after a newer one started leaves the newer run cancellable: unregister still stops it", async () => {
    const gates = [gatedChunk(), gatedChunk()];
    let loads = 0;
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => (gates[Math.min(loads++, 1)] as ReturnType<typeof gatedChunk>).chunk } });
    const [old, fresh] = gates as [ReturnType<typeof gatedChunk>, ReturnType<typeof gatedChunk>];
    const first = builder.execute("run_tests", {});
    await old.entered;
    builder.registration.runtimeReplaced();
    const second = builder.execute("run_tests", {});
    await fresh.entered;
    // Run A is still open while run B holds its cancel: A's end comes last.
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(builder.catalogue.shared.memory.cancelRun).toEqual(expect.any(Function));
    okOf(await first);
    // A's end left B's run flag and B's cancel alone: a third call is busy, and unregistering reaches B.
    expect(refusalOf(await builder.execute("run_tests", {}))).toMatchObject({ code: "busy", details: { because: "run-tests" } });
    builder.connection.abort();
    expect(fresh.state.cancels).toBe(1);
    expect(okOf(await second)).toMatchObject({ partial: true, pending: ["test-1", "test-2"], summary: { passed: 0, notRun: 2 } });
  });

  it("a reseed while the chunk loads answers partial with every test pending once it arrives, and runs nothing", async () => {
    const gated = gatedChunk();
    let release: ((chunk: TestsChunk) => void) | undefined;
    let loading = false;
    const builder = agentBuilder({
      tests: twoTests(),
      host: {
        loadTests: () => {
          loading = true;
          return new Promise<TestsChunk>((resolve) => {
            release = resolve;
          });
        }
      }
    });
    const call = builder.execute("run_tests", {});
    await vi.waitFor(() => expect(loading).toBe(true));
    builder.registration.runtimeReplaced();
    release?.(gated.chunk);
    expect(okOf(await call)).toMatchObject({ partial: true, pending: ["test-1", "test-2"], summary: { notRun: 2 } });
    expect(gated.state.entered).toBe(0);
    const rows = okOf(await builder.execute("list_tests", {})).tests as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.lastRun)).toEqual([undefined, undefined]);
  });

  it("unregister cancels the run in flight: the call answers partial with the rest pending", async () => {
    const gated = gatedChunk();
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => gated.chunk } });
    const call = builder.execute("run_tests", {});
    await gated.entered;
    gated.state.finish?.(["test-1"]);
    builder.connection.abort();
    expect(gated.state.cancels).toBe(1);
    expect(okOf(await call)).toMatchObject({ partial: true, pending: ["test-2"], summary: { passed: 1, notRun: 1 } });
  });

  it("returns what finished, partial, when the signal is aborted mid-run", async () => {
    const gated = gatedChunk();
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => gated.chunk } });
    const controller = new AbortController();
    const call = builder.execute("run_tests", {}, { signal: controller.signal });
    await gated.entered;
    gated.state.finish?.(["test-1"]);
    controller.abort();
    const result = okOf(await call);
    expect(gated.state.cancels).toBe(1);
    expect(result).toMatchObject({ partial: true, pending: ["test-2"] });
  });

  it("answers a second run busy { run-tests } at once, while reads keep running", async () => {
    const gated = gatedChunk();
    const builder = agentBuilder({ tests: twoTests(), host: { loadTests: async () => gated.chunk } });
    let settled = false;
    const first = builder.execute("run_tests", {}).then((result) => {
      settled = true;
      return result;
    });
    await gated.entered;
    const second = refusalOf(await builder.execute("run_tests", {}));
    expect(second.code).toBe("busy");
    expect(second.details).toEqual({ because: "run-tests" });
    expect(second.retryable).toBe(true);
    const read = okOf(await builder.execute("get_form", {}));
    expect(read.rootId).toBe("root");
    expect(settled).toBe(false);
    gated.state.finish?.(["test-1", "test-2"]);
    const done = okOf(await first);
    expect(done).toMatchObject({ partial: false, pending: [] });
    // The flag goes with the run: the next one runs.
    const again = builder.execute("run_tests", { ids: ["test-1"] });
    await vi.waitFor(() => expect(gated.state.entered).toBe(2));
    gated.state.finish?.(["test-1"]);
    expect(okOf(await again).partial).toBe(false);
  });

  it("answers chunk-unavailable, retryable, when the tests chunk does not load, and runs once it does", async () => {
    let fail = true;
    const builder = agentBuilder({
      host: {
        loadTests: async () => {
          if (fail) {
            throw new Error("404");
          }
          return REAL_CHUNK;
        }
      }
    });
    const refused = refusalOf(await builder.execute("run_tests", {}));
    expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "tests" } });
    fail = false;
    expect(okOf(await builder.execute("run_tests", {})).summary).toMatchObject({ passed: 1 });
  });

  it("names the person's unsaved edits as left out of the run", async () => {
    const builder = agentBuilder({ host: { loadTests: realTests() } });
    builder.controller.setDraftProperty("email", "label", "E-mail");
    const result = okOf(await builder.execute("run_tests", {}));
    expect(result.draftsExcluded).toEqual(["email"]);
    expect(result.warnings).toEqual(["drafts-excluded: the person's unsaved edits on email were not part of this run."]);
  });
});
