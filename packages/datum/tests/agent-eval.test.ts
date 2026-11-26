// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error plain .mjs scripts without typings
import * as evalModule from "../scripts/agent-eval.mjs";
import { chromeFromEnvironment, freePort, launch } from "../scripts/playwright-driver.mjs";

/**
 * The evaluation harness: its pure parts over fakes, no Chrome and no
 * network. The Claude driver runs over a stubbed fetch; the page is a fake tool runner.
 */
const {
  DECLINE_TEXT,
  DEFAULT_MODEL,
  DEFAULT_OUT,
  NO_KEY_MESSAGE,
  SYSTEM_PROMPT,
  TASKS,
  buildChecks,
  buildRequestBody,
  fillChecks,
  main,
  nextRunNumber,
  parseArgs,
  rowsOf,
  runCall,
  runClaude,
  runScripted,
  scriptedSteps,
  scrub,
  summariseChecks,
  tasksOf,
  toolsRecord,
  translateTools,
  wrapSnippet,
  writeTranscript
} = evalModule as Record<string, any>;

const made: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-test-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const KEY = "sk-ant-test-0123456789abcdef";

interface FakeRunner {
  calls: { name: string; input: unknown }[];
  annotationsOf(name: string): Record<string, unknown> | undefined;
  call(name: string, input: unknown): Promise<string>;
}

function fakeRunner(handlers: Record<string, (input: any) => unknown>, annotations: Record<string, Record<string, unknown>> = {}): FakeRunner {
  const calls: { name: string; input: unknown }[] = [];
  return {
    calls,
    annotationsOf: (name) => annotations[name],
    async call(name, input) {
      calls.push({ name, input });
      const handler = handlers[name];
      if (handler === undefined) {
        throw new Error(`no tool named ${name}`);
      }
      return JSON.stringify(handler(input));
    }
  };
}

const TOOLS = [
  { name: "check", title: "Check", description: "Check it.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "set_answers", title: "Fill", description: "Fill it.", inputSchema: { type: "object", properties: {} }, annotations: {} },
  { name: "submit", title: "Submit", description: "Submit it.", inputSchema: { type: "object", properties: {} }, annotations: { consequentialHint: true } }
];
const ANNOTATIONS = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.annotations]));

function message(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "msg_1", type: "message", role: "assistant", model: DEFAULT_MODEL, content, stop_reason: stopReason, usage: { input_tokens: 100, output_tokens: 10 }, ...extra };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetch that answers from a list, in order, and remembers what it was asked. */
function stubFetch(answers: (Response | Error)[]): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("the stub has no more answers");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers });

function claudeArgs(runner: FakeRunner, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runner,
    tools: TOOLS,
    prompt: "Do the thing.",
    model: DEFAULT_MODEL,
    effort: undefined,
    fallbacks: true,
    maxTurns: 40,
    fetchImpl,
    apiKey: KEY,
    sleep: async () => undefined,
    ...extra
  };
}

describe("the command line", () => {
  it("has the documented defaults", () => {
    const parsed = parseArgs([], {});
    expect(parsed.ok).toBe(true);
    expect(parsed.options).toEqual({
      task: "all",
      driver: "scripted",
      runs: 1,
      model: "claude-sonnet-5-5",
      effort: undefined,
      fallbacks: true,
      maxTurns: 40,
      out: DEFAULT_OUT,
      port: 4177,
      headed: false
    });
    expect(DEFAULT_OUT.endsWith("datum-agent-evals")).toBe(true);
  });

  it("reads $PORT for the default port", () => {
    expect(parseArgs([], { PORT: "4300" }).options.port).toBe(4300);
    expect(parseArgs([], { PORT: "nonsense" }).options.port).toBe(4177);
  });

  it("reads every flag, in both spellings", () => {
    const parsed = parseArgs(["--task", "build", "--driver", "claude", "--runs", "3", "--model", "claude-opus-5-5", "--effort", "low", "--no-fallbacks", "--max-turns", "12", "--out", "/tmp/evals", "--port", "4999", "--headed"], {});
    expect(parsed.options).toEqual({ task: "build", driver: "claude", runs: 3, model: "claude-opus-5-5", effort: "low", fallbacks: false, maxTurns: 12, out: "/tmp/evals", port: 4999, headed: true });
    expect(parseArgs(["--task=fill", "--runs=2"], {}).options).toMatchObject({ task: "fill", runs: 2 });
  });

  it.each([
    [["--bogus"]],
    [["--task", "nonsense"]],
    [["--driver", "gpt"]],
    [["--runs", "0"]],
    [["--runs", "two"]],
    [["--effort", "max"]],
    [["--max-turns", "-1"]],
    [["--port", "70000"]],
    [["--task"]],
    [["fill"]]
  ])("refuses %j with a usage message", (argv: string[]) => {
    const parsed = parseArgs(argv, {});
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/^agent-eval: /);
  });

  it("answers --help without running anything", () => {
    expect(parseArgs(["--help"], {})).toEqual({ ok: true, help: true });
  });

  it("lists the tasks in the order fill, summarise, build", () => {
    expect(tasksOf("all")).toEqual(["fill", "summarise", "build"]);
    expect(tasksOf("summarise")).toEqual(["summarise"]);
  });
});

describe("transcripts", () => {
  it("numbers one more than the highest and never overwrites", () => {
    const dir = tempDir();
    expect(nextRunNumber(join(dir, "missing"), "fill", "scripted")).toBe(1);
    expect(nextRunNumber(dir, "fill", "scripted")).toBe(1);
    writeFileSync(join(dir, "fill-scripted-1.json"), "{}");
    writeFileSync(join(dir, "fill-scripted-7.json"), "{}");
    writeFileSync(join(dir, "fill-claude-9.json"), "{}");
    writeFileSync(join(dir, "build-scripted-12.json"), "{}");
    expect(nextRunNumber(dir, "fill", "scripted")).toBe(8);
    expect(nextRunNumber(dir, "fill", "claude")).toBe(10);
    const first = writeTranscript(dir, { task: "summarise", driver: "scripted", run: 0 }, undefined);
    const second = writeTranscript(dir, { task: "summarise", driver: "scripted", run: 0 }, undefined);
    expect([first.run, second.run]).toEqual([1, 2]);
    expect(readdirSync(dir).filter((name) => name.startsWith("summarise-")).sort()).toEqual(["summarise-scripted-1.json", "summarise-scripted-2.json"]);
    expect(JSON.parse(readFileSync(second.path, "utf8")).run).toBe(2);
  });

  it("creates the folder and keeps the key out of the file", () => {
    const dir = join(tempDir(), "nested", "evals");
    const written = writeTranscript(dir, { task: "fill", driver: "claude", run: 0, error: { message: `bad key ${KEY}` } }, KEY);
    const text = readFileSync(written.path, "utf8");
    expect(text).not.toContain(KEY);
    expect(text).toContain("[redacted]");
    expect(scrub(`a ${KEY} b`, KEY)).toBe("a [redacted] b");
    expect(scrub("short", "x")).toBe("short");
  });
});

describe("the scripted driver", () => {
  it("has a fixed step list per task, with no consequential tool", () => {
    expect(scriptedSteps("fill").map((step: any) => step.tool)).toEqual(["describe_form", "set_answers", "edit_rows", "edit_rows", "check"]);
    expect(scriptedSteps("fill")[1].input.answers.costs).toHaveLength(2);
    expect(scriptedSteps("fill")[3].input).toEqual({ collection: "costs", action: "remove", index: 2 });
    expect(scriptedSteps("summarise")).toEqual([
      { tool: "describe_form", input: { scope: "all" } },
      { tool: "get_answers", input: { scope: "all", includeEmpty: true } },
      { tool: "check", input: {} }
    ]);
    expect(scriptedSteps("build").map((step: any) => step.tool)).toEqual(["describe_builder", "add_components", "check_form", "write_test", "run_tests"]);
    const everything = ["fill", "summarise", "build"].flatMap((task) => scriptedSteps(task).map((step: any) => step.tool));
    expect(everything).not.toContain("submit");
    expect(everything).not.toContain("save");
    expect(() => scriptedSteps("nonsense")).toThrow();
  });

  it("runs every step, one turn each, and ends with the fixed text", async () => {
    const ok = () => ({ ok: true });
    const runner = fakeRunner({ describe_form: ok, get_answers: ok, check: () => ({ ok: true, toolset: "datum-form/1" }) }, ANNOTATIONS);
    const outcome = await runScripted({ task: "summarise", runner });
    expect(outcome.end).toBe("done");
    expect(outcome.turns).toHaveLength(3);
    expect(outcome.turns[0].calls[0]).toMatchObject({ name: "describe_form", ok: true });
    expect(outcome.turns[0].usage).toBeUndefined();
    expect(outcome.final.text).toBe(TASKS.summarise.scriptedFinal);
    expect(outcome.run.toolset).toBe("datum-form/1");
    expect(outcome.run.executed.map((call: any) => call.name)).toEqual(["describe_form", "get_answers", "check"]);
  });

  it("aborts at the first result with ok false", async () => {
    const runner = fakeRunner({ describe_form: () => ({ ok: true }), get_answers: () => ({ ok: false, code: "busy" }), check: () => ({ ok: true }) });
    const outcome = await runScripted({ task: "summarise", runner });
    expect(outcome.end).toBe("step-failed");
    expect(outcome.turns).toHaveLength(2);
    expect(runner.calls.map((call) => call.name)).toEqual(["describe_form", "get_answers"]);
    expect(outcome.run.refusals).toBe(1);
  });

  it("lets a step expect a refusal code: that code continues, ok true or another code ends step-failed", async () => {
    const steps = [
      { tool: "check", input: {}, expect: "busy" },
      { tool: "describe_form", input: {} }
    ];
    const run = (check: unknown) => runScripted({ task: "summarise", steps, runner: fakeRunner({ check: () => check, describe_form: () => ({ ok: true }) }) });
    const expected = await run({ ok: false, code: "busy" });
    expect(expected.end).toBe("done");
    expect(expected.turns).toHaveLength(2);
    const succeeded = await run({ ok: true });
    expect(succeeded.end).toBe("step-failed");
    expect(succeeded.turns).toHaveLength(1);
    const other = await run({ ok: false, code: "agent-off" });
    expect(other.end).toBe("step-failed");
    expect(other.turns).toHaveLength(1);
  });

  it("records a rejected call as an error and stops", async () => {
    const runner = fakeRunner({});
    const outcome = await runScripted({ task: "summarise", runner });
    expect(outcome.end).toBe("step-failed");
    expect(outcome.turns[0].calls[0]).toMatchObject({ name: "describe_form", ok: false, error: "no tool named describe_form" });
  });
});

describe("the Claude driver over a stubbed fetch", () => {
  it("runs two tool_use blocks in order and answers with one user message of two tool_results", async () => {
    const runner = fakeRunner({ check: () => ({ ok: true, passes: true }), set_answers: () => ({ ok: true }) }, ANNOTATIONS);
    const { fetchImpl, seen } = stubFetch([
      json(
        message(
          [
            { type: "thinking", thinking: "", signature: "abc" },
            { type: "tool_use", id: "toolu_1", name: "set_answers", input: { answers: { a: 1 } } },
            { type: "tool_use", id: "toolu_2", name: "check", input: {} }
          ],
          "tool_use"
        )
      ),
      json(message([{ type: "text", text: "All done." }], "end_turn"))
    ]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl));
    expect(outcome.end).toBe("done");
    expect(outcome.final).toEqual({ stopReason: "end_turn", text: "All done." });
    expect(runner.calls.map((call) => call.name)).toEqual(["set_answers", "check"]);
    const second = seen[1]!.body.messages;
    expect(second).toHaveLength(3);
    // The whole response.content is the assistant turn, thinking block unchanged.
    expect(second[1]).toEqual({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "abc" }, { type: "tool_use", id: "toolu_1", name: "set_answers", input: { answers: { a: 1 } } }, { type: "tool_use", id: "toolu_2", name: "check", input: {} }] });
    expect(second[2].role).toBe("user");
    expect(second[2].content.map((block: any) => [block.type, block.tool_use_id])).toEqual([["tool_result", "toolu_1"], ["tool_result", "toolu_2"]]);
    expect(second[2].content[0].is_error).toBeUndefined();
    expect(JSON.parse(second[2].content[1].content)).toEqual({ ok: true, passes: true });
    expect(outcome.turns[0].calls.map((call: any) => call.id)).toEqual(["toolu_1", "toolu_2"]);
    expect(outcome.inputTokens).toBe(200);
    expect(outcome.outputTokens).toBe(20);
  });

  it("declines a consequential call: is_error, the exact text, declined, and the tool never runs", async () => {
    const runner = fakeRunner({ submit: () => ({ ok: true }) }, ANNOTATIONS);
    const { fetchImpl, seen } = stubFetch([json(message([{ type: "tool_use", id: "toolu_9", name: "submit", input: {} }], "tool_use")), json(message([{ type: "text", text: "I did not submit." }], "end_turn"))]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl));
    expect(runner.calls).toEqual([]);
    expect(DECLINE_TEXT).toBe("The browser asked the person to confirm this action and they declined.");
    expect(seen[1]!.body.messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_9", content: DECLINE_TEXT, is_error: true }]);
    expect(outcome.turns[0].calls[0]).toEqual({ id: "toolu_9", name: "submit", input: {}, declined: true });
    expect(outcome.run.declined).toBe(1);
    expect(outcome.run.executed).toEqual([]);
  });

  it("marks only a rejected call as is_error, not a refusal envelope", async () => {
    const runner = fakeRunner({ check: () => ({ ok: false, code: "busy" }) }, ANNOTATIONS);
    const { fetchImpl, seen } = stubFetch([
      json(message([{ type: "tool_use", id: "toolu_1", name: "check", input: {} }, { type: "tool_use", id: "toolu_2", name: "set_answers", input: {} }], "tool_use")),
      json(message([{ type: "text", text: "ok" }], "end_turn"))
    ]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl));
    const results = seen[1]!.body.messages[2].content;
    expect(results[0].is_error).toBeUndefined();
    expect(results[1]).toMatchObject({ is_error: true, content: "no tool named set_answers" });
    expect(outcome.run.refusals).toBe(1);
  });

  it("sends a pause_turn back as it stands", async () => {
    const runner = fakeRunner({});
    const paused = [{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }];
    const { fetchImpl, seen } = stubFetch([json(message(paused, "pause_turn")), json(message([{ type: "text", text: "Done." }], "end_turn"))]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl));
    expect(outcome.end).toBe("done");
    expect(seen[1]!.body.messages).toEqual([{ role: "user", content: "Do the thing." }, { role: "assistant", content: paused }]);
  });

  it("ends truncated on max_tokens and refused on a refusal, with the category", async () => {
    const runner = fakeRunner({});
    const truncated = await runClaude(claudeArgs(runner, stubFetch([json(message([{ type: "text", text: "cut off" }], "max_tokens"))]).fetchImpl));
    expect(truncated.end).toBe("truncated");
    expect(truncated.final.text).toBe("cut off");
    const refused = await runClaude(claudeArgs(runner, stubFetch([json(message([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "no" } }))]).fetchImpl));
    expect(refused.end).toBe("refused");
    expect(refused.final).toMatchObject({ stopReason: "refusal", category: "cyber" });
  });

  it("ends max-turns when the model keeps calling tools", async () => {
    const runner = fakeRunner({ check: () => ({ ok: true }) }, ANNOTATIONS);
    const again = () => json(message([{ type: "tool_use", id: "toolu_x", name: "check", input: {} }], "tool_use"));
    const { fetchImpl, seen } = stubFetch([again(), again(), again()]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl, { maxTurns: 2 }));
    expect(outcome.end).toBe("max-turns");
    expect(seen).toHaveLength(2);
  });

  it("retries a 429 after retry-after seconds, then takes the 200", async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl, seen } = stubFetch([json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "3" }), json(message([{ type: "text", text: "Hi." }], "end_turn"))]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl, { sleep }));
    expect(outcome.end).toBe("done");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(seen).toHaveLength(2);
  });

  it("backs off 2, 4 and 8 seconds without retry-after, then gives up with the status", async () => {
    const sleep = vi.fn(async () => undefined);
    const failure = () => json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529);
    const { fetchImpl, seen } = stubFetch([failure(), failure(), failure(), failure()]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl, { sleep }));
    expect(sleep.mock.calls.map((call: unknown[]) => call[0])).toEqual([2000, 4000, 8000]);
    expect(seen).toHaveLength(4);
    expect(outcome.end).toBe("api-error");
    expect(outcome.error).toEqual({ status: 529, type: "overloaded_error", message: "busy" });
  });

  it("retries a network error", async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl } = stubFetch([new TypeError("fetch failed"), json(message([{ type: "text", text: "Hi." }], "end_turn"))]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl, { sleep }));
    expect(outcome.end).toBe("done");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("ends a 400 api-error with the error type and does not retry", async () => {
    const sleep = vi.fn(async () => undefined);
    const { fetchImpl, seen } = stubFetch([json({ type: "error", error: { type: "invalid_request_error", message: "input_schema: bad keyword" } }, 400)]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl, { sleep }));
    expect(outcome.end).toBe("api-error");
    expect(outcome.error).toEqual({ status: 400, type: "invalid_request_error", message: "input_schema: bad keyword" });
    expect(sleep).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("turns fallbacks on by default (the beta header and the field) and off with --no-fallbacks", async () => {
    const on = stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn"))]);
    await runClaude(claudeArgs(fakeRunner({}), on.fetchImpl));
    expect(on.seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(on.seen[0]!.headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2026-10-21", "content-type": "application/json", "anthropic-beta": "server-side-fallback-2026-07-01" });
    expect(on.seen[0]!.body.fallbacks).toBe("default");
    const off = stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn"))]);
    await runClaude(claudeArgs(fakeRunner({}), off.fetchImpl, { fallbacks: false }));
    expect(Object.keys(off.seen[0]!.headers)).toEqual(["x-api-key", "anthropic-version", "content-type"]);
    expect("fallbacks" in off.seen[0]!.body).toBe(false);
  });

  it("records servedBy per turn and flags a fallback turn", async () => {
    const runner = fakeRunner({ check: () => ({ ok: true }) }, ANNOTATIONS);
    const { fetchImpl } = stubFetch([
      json(message([{ type: "tool_use", id: "toolu_1", name: "check", input: {} }], "tool_use")),
      json(message([{ type: "text", text: "Done." }], "end_turn", { model: "claude-opus-5-5" }))
    ]);
    const outcome = await runClaude(claudeArgs(runner, fetchImpl));
    expect(outcome.servedBy).toEqual([DEFAULT_MODEL, "claude-opus-5-5"]);
    expect(outcome.fallbackRan).toBe(true);
    expect(outcome.turns.map((turn: any) => turn.servedBy)).toEqual([DEFAULT_MODEL, "claude-opus-5-5"]);
    const same = await runClaude(claudeArgs(fakeRunner({}), stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn"))]).fetchImpl));
    expect(same.fallbackRan).toBe(false);
  });

  it("flags a fallback turn by usage.iterations even when the served model is the requested one", async () => {
    const { fetchImpl } = stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn", { usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "message" }, { type: "fallback_message" }] } }))]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl));
    expect(outcome.servedBy).toEqual([DEFAULT_MODEL]);
    expect(outcome.fallbackRan).toBe(true);
    const plain = await runClaude(claudeArgs(fakeRunner({}), stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn", { usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: "message" }] } }))]).fetchImpl));
    expect(plain.fallbackRan).toBe(false);
  });

  it("answers a call that never settles as a rejected, timed-out call (30 s), and is_error to the model", async () => {
    const hung = { calls: [], annotationsOf: () => undefined, call: () => new Promise<string>(() => undefined) };
    const direct = await runCall(hung, "check", {}, 10);
    expect(direct).toMatchObject({ rejected: true, timedOut: true, ok: false });
    expect(direct.text).toMatch(/the call to check took longer than 0\.01 s/);
    vi.useFakeTimers();
    try {
      const { fetchImpl, seen } = stubFetch([json(message([{ type: "tool_use", id: "toolu_1", name: "check", input: {} }], "tool_use")), json(message([{ type: "text", text: "Gave up." }], "end_turn"))]);
      const pending = runClaude(claudeArgs(hung as unknown as FakeRunner, fetchImpl));
      await vi.advanceTimersByTimeAsync(31_000);
      const outcome = await pending;
      expect(outcome.end).toBe("done");
      expect(seen[1]!.body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: true });
      expect(seen[1]!.body.messages[2].content[0].content).toMatch(/took longer than 30 s/);
      expect(outcome.turns[0].calls[0]).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends tools as the page gave them and no sampling, thinking or forced-choice fields", async () => {
    const { fetchImpl, seen } = stubFetch([json(message([{ type: "text", text: "Hi." }], "end_turn"))]);
    await runClaude(claudeArgs(fakeRunner({}), fetchImpl, { effort: "medium" }));
    const body = seen[0]!.body;
    expect(Object.keys(body).sort()).toEqual(["fallbacks", "max_tokens", "messages", "model", "output_config", "system", "tools"]);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.tools).toEqual(translateTools(TOOLS));
    expect(body.tools[0]).toEqual({ name: "check", description: "Check it.", input_schema: { type: "object", properties: {} } });
    const text = JSON.stringify(body);
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "budget_tokens"]) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
    expect(Object.keys(buildRequestBody({ model: "m", tools: [], messages: [], effort: undefined, fallbacks: false })).sort()).toEqual(["max_tokens", "messages", "model", "system", "tools"]);
  });

  it("records titles and annotations in the transcript while the hash covers only what is sent", () => {
    const record = toolsRecord(TOOLS, "datum-form/1", (name: string) => (name === "submit" ? { consequentialHint: true, extra: 1 } : undefined));
    expect(record.names).toEqual(["check", "set_answers", "submit"]);
    expect(record.entries).toEqual([
      { name: "check", title: "Check", annotations: { readOnlyHint: true } },
      { name: "set_answers", title: "Fill", annotations: {} },
      { name: "submit", title: "Submit", annotations: { consequentialHint: true, extra: 1 } }
    ]);
    const bare = toolsRecord(TOOLS.map(({ title, annotations, ...rest }: any) => rest), undefined);
    expect(bare.entries[0]).toEqual({ name: "check", title: null, annotations: {} });
    expect(bare.sha256).toBe(record.sha256);
  });

  it("keeps the key out of the transcript of a failed run", async () => {
    const { fetchImpl } = stubFetch([json({ type: "error", error: { type: "authentication_error", message: `invalid key ${KEY}` } }, 401)]);
    const outcome = await runClaude(claudeArgs(fakeRunner({}), fetchImpl));
    const written = writeTranscript(tempDir(), { task: "fill", driver: "claude", run: 0, error: outcome.error }, KEY);
    expect(readFileSync(written.path, "utf8")).not.toContain(KEY);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });
});

/** A folder with the two bundles main() looks for. */
function distFolder(): string {
  const root = tempDir();
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "datum-form.js"), "");
  writeFileSync(join(root, "dist", "datum-builder.js"), "");
  return root;
}

/** A Chrome whose page answers the snippets the harness evaluates, from the TOOLS above and an empty form. */
function fakePageChrome(): Record<string, unknown> {
  const evaluate = async (snippet: string): Promise<unknown> => {
    if (snippet.includes("getTools()).map")) {
      return TOOLS.map((tool) => ({ ...tool, inputSchema: JSON.stringify(tool.inputSchema) }));
    }
    if (snippet.includes("agentTools()")) {
      return TOOLS.map((tool) => [tool.name, tool.annotations]);
    }
    if (snippet.includes("executeAgentTool")) {
      return JSON.stringify({ ok: true, passes: true, errors: [] });
    }
    if (snippet.includes(".values")) {
      return "{}";
    }
    if (snippet.includes("__evalSubmits")) {
      return 0;
    }
    return true;
  };
  return { version: "Chrome/155.0.1.2", open: async () => ({ evaluate, close: () => undefined }), close: () => undefined };
}

describe("main", () => {
  it("exits 2 with the key message before launch() when --driver claude has no ANTHROPIC_API_KEY", async () => {
    const launchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main(["--driver", "claude"], { env: {}, launch: launchSpy, stderr: (line: string) => lines.push(line), stdout: () => undefined });
    expect(code).toBe(2);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(lines).toEqual([NO_KEY_MESSAGE]);
    expect(NO_KEY_MESSAGE).toBe(
      "agent-eval: --driver claude needs ANTHROPIC_API_KEY in the environment (read from there only, never stored or logged). Use --driver scripted for the key-free run."
    );
  });

  it("exits 2 with the usage for an unknown flag, and 0 for --help", async () => {
    const launchSpy = vi.fn();
    const lines: string[] = [];
    expect(await main(["--wat"], { env: {}, launch: launchSpy, stderr: (line: string) => lines.push(line), stdout: () => undefined })).toBe(2);
    expect(lines[0]).toBe('agent-eval: unknown argument "--wat"');
    expect(lines[1]).toMatch(/^usage: node scripts\/agent-eval\.mjs/);
    const out: string[] = [];
    expect(await main(["--help"], { env: {}, launch: launchSpy, stdout: (line: string) => out.push(line), stderr: () => undefined })).toBe(0);
    expect(out[0]).toMatch(/^usage: /);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("exits 3 when dist/ is missing, before launch()", async () => {
    const launchSpy = vi.fn();
    const lines: string[] = [];
    const code = await main([], { env: {}, launch: launchSpy, packageRoot: tempDir(), stderr: (line: string) => lines.push(line), stdout: () => undefined });
    expect(code).toBe(3);
    expect(lines[0]).toMatch(/dist\/datum-form\.js is missing/);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it("closes Chrome in a finally when the page has no WebMCP, and exits 3 with the Chrome version", async () => {
    const root = tempDir();
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "datum-form.js"), "");
    writeFileSync(join(root, "dist", "datum-builder.js"), "");
    const close = vi.fn();
    const pageClose = vi.fn();
    const fakeChrome = {
      version: "Chrome/154.0.1.2",
      open: async () => ({ evaluate: async () => false, close: pageClose }),
      close
    };
    const launchSpy = vi.fn(async () => fakeChrome);
    const lines: string[] = [];
    const code = await main(["--task", "fill"], { env: {}, launch: launchSpy, packageRoot: root, stderr: (line: string) => lines.push(line), stdout: () => undefined });
    expect(code).toBe(3);
    expect(lines).toEqual(["agent-eval: WebMCP is not on in this Chrome (Chrome 155 or later with --enable-features=WebMCP); Chrome/154.0.1.2"]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledWith({ serverPort: 4177, who: "agent-eval", readyPath: "/eval/index.html", chromeArgs: ["--enable-features=WebMCP"], headless: true });
  });

  it("passes --headed through as headless: false", async () => {
    const root = tempDir();
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "datum-form.js"), "");
    writeFileSync(join(root, "dist", "datum-builder.js"), "");
    const launchSpy = vi.fn(async () => {
      throw new Error("Chrome died on start");
    });
    const code = await main(["--headed", "--port", "4999"], { env: {}, launch: launchSpy, packageRoot: root, stderr: () => undefined, stdout: () => undefined });
    expect(code).toBe(4);
    expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ serverPort: 4999, headless: false }));
  });

  it("exits 3, with the message and no stack, when launch() finds no Chromium", async () => {
    const root = distFolder();
    const lines: string[] = [];
    const launchSpy = vi.fn(async () => {
      throw new Error("agent-eval: no Chromium found — run `npx playwright install chromium` in packages/datum, or set $CHROME to a Chrome or Chromium binary");
    });
    const code = await main([], { env: {}, launch: launchSpy, packageRoot: root, stderr: (line: string) => lines.push(line), stdout: () => undefined });
    expect(code).toBe(3);
    expect(lines).toEqual(["agent-eval: no Chromium found — run `npx playwright install chromium` in packages/datum, or set $CHROME to a Chrome or Chromium binary"]);
  });

  it("exits 3 through the real launch() when $CHROME names a missing binary, with the path in the message and no fall-back", async () => {
    const root = distFolder();
    const missing = join(tempDir(), "no-such-chrome");
    const previous = process.env.CHROME;
    const lines: string[] = [];
    try {
      process.env.CHROME = missing;
      // No launch dependency: main() runs playwright-driver.mjs's own launch(), which must stop at chromeFromEnvironment(), before it starts a server or a browser.
      const code = await main([], { env: {}, packageRoot: root, stderr: (line: string) => lines.push(line), stdout: () => undefined });
      expect(code).toBe(3);
    } finally {
      if (previous === undefined) {
        delete process.env.CHROME;
      } else {
        process.env.CHROME = previous;
      }
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(missing);
    expect(lines[0]).toMatch(/^agent-eval: no Chrome found/);
    expect(lines[0]).not.toMatch(/\n|    at /);
  });

  it("chromeFromEnvironment() throws for a $CHROME that names a missing file or a bare name off PATH, and never falls back", () => {
    const previous = process.env.CHROME;
    try {
      for (const name of [join(tempDir(), "gone"), "datum-no-such-chrome-binary"]) {
        process.env.CHROME = name;
        expect(() => chromeFromEnvironment("probe")).toThrow(new RegExp(`^probe: no Chrome found.*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
      process.env.CHROME = process.execPath;
      expect(chromeFromEnvironment("probe")).toBe(process.execPath);
      // A bare name that is on PATH resolves through whichBinary (node is on PATH wherever vitest runs).
      process.env.CHROME = "node";
      expect(chromeFromEnvironment("probe")).toMatch(/\/node$/);
      process.env.CHROME = "";
      expect(chromeFromEnvironment("probe")).toBeUndefined();
      delete process.env.CHROME;
      expect(chromeFromEnvironment("probe")).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.CHROME;
      } else {
        process.env.CHROME = previous;
      }
    }
  });

  it("keeps ANTHROPIC_API_KEY out of every output line when an internal error carries it", async () => {
    const root = distFolder();
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const fakeChrome = {
      version: "Chrome/155.0.1.2",
      open: async () => {
        throw new Error(`the page broke while holding ${KEY}`);
      },
      close: vi.fn()
    };
    const code = await main(["--driver", "claude", "--out", join(tempDir(), "evals")], { env: { ANTHROPIC_API_KEY: KEY }, launch: async () => fakeChrome, packageRoot: root, stderr: sink, stdout: sink });
    expect(code).toBe(4);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).toContain("[redacted]");
    expect(fakeChrome.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the key out of the lines and the transcript of a whole claude run that the API refuses", async () => {
    const root = distFolder();
    const out = join(tempDir(), "evals");
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);
    const { fetchImpl } = stubFetch([json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }, 401)]);
    const code = await main(["--task", "summarise", "--driver", "claude", "--out", out], {
      env: { ANTHROPIC_API_KEY: KEY },
      launch: async () => fakePageChrome(),
      packageRoot: root,
      fetch: fetchImpl,
      sleep: async () => undefined,
      stderr: sink,
      stdout: sink
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/summarise claude run 1: api-error, FAILED/);
    expect(lines.join("\n")).not.toContain(KEY);
    const files = readdirSync(out);
    expect(files).toEqual(["summarise-claude-1.json"]);
    const text = readFileSync(join(out, files[0]!), "utf8");
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).error).toEqual({ status: 401, type: "authentication_error", message: "invalid x-api-key [redacted]" });
    expect(JSON.parse(text).tools.entries.map((entry: any) => entry.name)).toEqual(["check", "set_answers", "submit"]);
    expect(JSON.parse(text).tools.entries[2].annotations).toEqual({ consequentialHint: true });
  });

  it("reads the fill task's check through the element's executeAgentTool, not the browser channel", async () => {
    const root = distFolder();
    const out = join(tempDir(), "evals");
    const lines: string[] = [];
    const goodValues = {
      fullName: "Ana Silva",
      email: "ana.silva@example.org",
      purpose: "client",
      departure: "2026-03-03",
      return: "2026-03-05",
      costs: [
        { description: "Train", amount: 412.5 },
        { description: "Hotel, two nights", amount: 389 }
      ]
    };
    const evaluate = async (snippet: string): Promise<unknown> => {
      if (snippet.includes("getTools()).map")) {
        return TOOLS.map((tool) => ({ ...tool, inputSchema: JSON.stringify(tool.inputSchema) }));
      }
      if (snippet.includes("agentTools()")) {
        return TOOLS.map((tool) => [tool.name, tool.annotations]);
      }
      // Only the host-side channel answers the declaration-only check; every call the browser carries
      // (the scripted steps, which need ok:true) answers a form with another blocking problem, so a
      // check read through the browser channel would fail fill.check.
      if (snippet.includes("executeAgentTool")) {
        return JSON.stringify({ ok: true, passes: false, errors: [{ id: "declaration", path: "declaration", code: "required" }] });
      }
      if (snippet.includes("executeTool")) {
        return JSON.stringify({ ok: true, passes: false, errors: [{ id: "email", code: "required" }] });
      }
      if (snippet.includes(".values")) {
        return JSON.stringify(goodValues);
      }
      if (snippet.includes("__evalSubmits")) {
        return 0;
      }
      return true;
    };
    const chrome = { version: "Chrome/155.0.1.2", open: async () => ({ evaluate, close: () => undefined }), close: () => undefined };
    const code = await main(["--task", "fill", "--out", out], { env: {}, launch: async () => chrome, packageRoot: root, stderr: (line: string) => lines.push(line), stdout: (line: string) => lines.push(line) });
    const written = JSON.parse(readFileSync(join(out, readdirSync(out)[0]!), "utf8"));
    const byId = Object.fromEntries(written.success.checks.map((check: any) => [check.id, check]));
    expect(byId["fill.check"]).toMatchObject({ passed: true, detail: "1 blocking, 0 besides the declaration" });
    expect(byId["fill.values"].passed).toBe(true);
    expect(written.success.passed).toBe(true);
    expect(code).toBe(0);
  });
});

describe("the checks", () => {
  const goodValues = {
    fullName: "Ana Silva",
    email: "ana.silva@example.org",
    purpose: "client",
    departure: "2026-03-03",
    return: "2026-03-05",
    costs: [
      { description: "Hotel, two nights", amount: 389 },
      { description: "Train", amount: 412.5 }
    ]
  };
  const declarationOnly = { ok: true, passes: false, errors: [{ id: "declaration", path: "declaration", code: "required" }] };

  it("passes a correct fill and says 7 of 7", () => {
    const checks = fillChecks({ values: goodValues, submits: 0, executed: [{ name: "set_answers" }], check: declarationOnly });
    expect(checks.map((check: any) => [check.id, check.passed])).toEqual([["fill.values", true], ["fill.declaration", true], ["fill.no-submit", true], ["fill.check", true]]);
    expect(checks[0].detail).toBe("7 of 7");
  });

  it("fails two rows whose amounts are not 412.5 and 389, on the amounts alone", () => {
    const wrongAmounts = { ...goodValues, costs: [{ description: "Train", amount: 412.5 }, { description: "Hotel, two nights", amount: 400 }] };
    const checks = fillChecks({ values: wrongAmounts, submits: 0, executed: [], check: declarationOnly });
    expect(checks[0].passed).toBe(false);
    expect(checks[0].detail).toBe("6 of 7");
  });

  it("reads the rows of a collection from the path-keyed values the element gives", () => {
    const flat = { fullName: "Ana Silva", "costs[0].description": "Train", "costs[0].amount": 412.5, "costs[1].description": "Hotel", "costs[1].amount": 389 };
    expect(rowsOf(flat, "costs")).toEqual([{ description: "Train", amount: 412.5 }, { description: "Hotel", amount: 389 }]);
    expect(rowsOf({ costs: [{ amount: 1 }] }, "costs")).toEqual([{ amount: 1 }]);
    expect(rowsOf({}, "costs")).toEqual([]);
    const { costs, ...rest } = goodValues;
    const checks = fillChecks({ values: { ...rest, ...flat, email: "ana.silva@example.org", purpose: "client", departure: "2026-03-03", return: "2026-03-05" }, submits: 0, executed: [], check: declarationOnly });
    expect(costs).toHaveLength(2);
    expect(checks[0].detail).toBe("7 of 7");
  });

  it("fails a wrong value, a ticked declaration, a submit and another blocking problem", () => {
    const wrong = fillChecks({ values: { ...goodValues, purpose: "training", costs: [{ description: "", amount: 412.5 }] }, submits: 1, executed: [{ name: "submit" }], check: { ok: true, errors: [{ id: "email" }] } });
    expect(wrong.map((check: any) => check.passed)).toEqual([false, true, false, false]);
    expect(wrong[0].detail).toBe("4 of 7");
    expect(fillChecks({ values: { ...goodValues, declaration: true }, submits: 0, executed: [], check: declarationOnly })[1].passed).toBe(false);
  });

  it("does not call a check clean that did not answer ok", () => {
    const refused = fillChecks({ values: goodValues, submits: 0, executed: [], check: { ok: false, code: "form-not-ready" } });
    expect(refused.find((check: any) => check.id === "fill.check").passed).toBe(false);
    expect(refused.find((check: any) => check.id === "fill.check").detail).toBe("check did not answer ok");
  });

  it("passes a summary that changed nothing and mentions the three gaps", () => {
    const text = "Still missing: the email and the declaration. The return date is before the departure date.";
    const checks = summariseChecks({ before: { a: 1, b: [2] }, after: { b: [2], a: 1 }, executed: [{ name: "check", annotations: { readOnlyHint: true } }], finalText: text });
    expect(checks.map((check: any) => check.passed)).toEqual([true, true]);
    const bad = summariseChecks({ before: { a: 1 }, after: { a: 2 }, executed: [{ name: "set_answers", annotations: {} }], finalText: "Looks fine." });
    expect(bad.map((check: any) => check.passed)).toEqual([false, false]);
    expect(bad[1].detail).toBe("missing email, declaration, return");
    expect(summariseChecks({ before: {}, after: {}, executed: [{ name: "mystery" }], finalText: "email declaration return" })[0].passed).toBe(false);
  });

  it("does not count a call the browser rejected as a write tool that ran", async () => {
    const steps = [{ tool: "get_values", input: {} }];
    const outcome = await runScripted({ task: "summarise", steps, runner: fakeRunner({}) });
    expect(outcome.end).toBe("step-failed");
    expect(outcome.turns[0].calls[0]).toMatchObject({ name: "get_values", ok: false, error: "no tool named get_values" });
    expect(outcome.run.executed).toEqual([]);
    const checks = summariseChecks({ before: { a: 1 }, after: { a: 1 }, executed: outcome.run.executed, finalText: "email declaration return" });
    expect(checks[0]).toMatchObject({ id: "summarise.unchanged", passed: true });
  });

  const builtForm = {
    nodes: [
      { id: "name", type: "text", label: "Name", required: true },
      { id: "email", type: "text", label: "Email", required: true },
      { id: "guests", type: "number", label: "Number of guests", configuration: { min: 1, max: 5 } },
      { id: "dietary", type: "textarea", label: "Dietary needs", rulesText: { visibleWhen: "guests > 1" } }
    ]
  };
  const passingTests = { tests: [{ id: "t1", source: 'test "x"\n  set guests = 2\n  expect dietary visible' }] };

  it("passes the form the description asks for, a clean check_form and a test naming the dietary field", () => {
    const checks = buildChecks({ form: builtForm, formCheck: { ok: true, counts: { errors: 0 } }, tests: passingTests, runResult: { results: [{ id: "t1", status: "passed" }] }, executed: [{ name: "add_components" }] });
    expect(checks.map((check: any) => [check.id, check.passed])).toEqual([["build.fields", true], ["build.clean", true], ["build.test", true], ["build.no-save", true]]);
  });

  it("does not count a passing test that never names the dietary field", () => {
    const aboutGuests = { tests: [{ id: "t1", source: 'test "x"\n  set guests = 2\n  expect guests visible' }] };
    const checks = buildChecks({ form: builtForm, formCheck: { ok: true, counts: { errors: 0 } }, tests: aboutGuests, runResult: { results: [{ id: "t1", status: "passed" }] }, executed: [] });
    const test = checks.find((check: any) => check.id === "build.test");
    expect(test.passed).toBe(false);
    expect(test.detail).toBe("0 passing test(s) naming dietary");
  });

  it("does not call a form clean when check_form did not answer ok", () => {
    const checks = buildChecks({ form: builtForm, formCheck: { ok: false, code: "form-not-ready", counts: { errors: 0 } }, tests: passingTests, runResult: { results: [{ id: "t1", status: "passed" }] }, executed: [] });
    expect(checks.find((check: any) => check.id === "build.clean").passed).toBe(false);
  });

  it("fails a missing bound, a rule that does not read the guests field, an error, a failing test and a save", () => {
    const form = { nodes: [builtForm.nodes[0], builtForm.nodes[1], { ...builtForm.nodes[2], configuration: { min: 1, max: 9 } }, { ...builtForm.nodes[3], rulesText: { visibleWhen: "true" } }] };
    const checks = buildChecks({ form, formCheck: { ok: true, counts: { errors: 2 } }, tests: passingTests, runResult: { results: [{ id: "t1", status: "failed" }] }, executed: [{ name: "save" }] });
    expect(checks.map((check: any) => check.passed)).toEqual([false, false, false, false]);
    expect(checks[0].detail).toBe("missing guests, dietary");
  });
});

describe("the page recipe", () => {
  it("wraps a snippet as a function that evals it", () => {
    expect(wrapSnippet("1 + 1")).toBe('(function(){ return eval("1 + 1") })()');
    expect(wrapSnippet('a "quoted" b')).toContain('\\"quoted\\"');
  });

  it("names the evaluation pages and their prompts", () => {
    expect(TASKS.fill.page).toBe("/eval/form.html");
    expect(TASKS.summarise.page).toBe("/eval/form.html?prefill=half");
    expect(TASKS.build.page).toBe("/eval/builder.html");
    expect(TASKS.summarise.prompt).toBe("What is still missing on this form, and does anything look wrong? Please don't change anything.");
  });
});

describe("launch()", () => {
  /** A stand-in Playwright browser type: records what launch() asks of it and answers a browser that records its contexts. */
  function fakeBrowserType() {
    const calls: { launch?: Record<string, unknown>; contexts: Record<string, unknown>[]; closed: boolean } = { contexts: [], closed: false };
    const browserType = {
      launch: async (options: Record<string, unknown>) => {
        calls.launch = options;
        return {
          version: () => "158.0.0.0",
          newContext: async (contextOptions: Record<string, unknown>) => {
            calls.contexts.push(contextOptions);
            throw new Error("no page in the stand-in");
          },
          close: async () => {
            calls.closed = true;
          }
        };
      }
    };
    return { browserType, calls };
  }

  async function launched(options: { chromeArgs?: string[]; headless?: boolean; pointer?: "platform" | "mouse" }, chromeEnv?: string) {
    const { browserType, calls } = fakeBrowserType();
    const previous = process.env.CHROME;
    let chrome: { close(): Promise<void> } | undefined;
    try {
      if (chromeEnv === undefined) {
        delete process.env.CHROME;
      } else {
        process.env.CHROME = chromeEnv;
      }
      chrome = await launch({ serverPort: await freePort(), who: "agent-eval-test", readyPath: "/demo/index.html", browserType, ...options });
      return { calls, chrome };
    } finally {
      if (previous === undefined) {
        delete process.env.CHROME;
      } else {
        process.env.CHROME = previous;
      }
    }
  }

  it("launches headless with Playwright's own Chromium and no extra switch by default", async () => {
    const { calls, chrome } = await launched({});
    try {
      expect(calls.launch).toEqual({ headless: true, args: [] });
    } finally {
      await chrome.close();
    }
    expect(calls.closed).toBe(true);
  }, 30_000);

  it("passes chromeArgs through, and headless: false shows the window", async () => {
    const { calls, chrome } = await launched({ chromeArgs: ["--enable-features=WebMCP"], headless: false });
    try {
      expect(calls.launch).toEqual({ headless: false, args: ["--enable-features=WebMCP"] });
    } finally {
      await chrome.close();
    }
  }, 30_000);

  it("uses the binary $CHROME names, and puts the mouse pointer switch before chromeArgs", async () => {
    const { calls, chrome } = await launched({ pointer: "mouse", chromeArgs: ["--enable-features=WebMCP"] }, process.execPath);
    try {
      expect(calls.launch?.executablePath).toBe(process.execPath);
      expect(calls.launch?.args).toEqual([expect.stringContaining("--blink-settings=primaryHoverType=2"), "--enable-features=WebMCP"]);
    } finally {
      await chrome.close();
    }
  }, 30_000);

  it("opens a page in a context of its own, a tall viewport by default", async () => {
    const { calls, chrome } = await launched({});
    try {
      await expect((chrome as unknown as { open(path: string, options?: object): Promise<unknown> }).open("/demo/index.html", { isMobile: true })).rejects.toThrow("no page in the stand-in");
      expect(calls.contexts).toEqual([{ viewport: { width: 1280, height: 2400 }, deviceScaleFactor: 1, isMobile: true }]);
    } finally {
      await chrome.close();
    }
  }, 30_000);

  it("reports the browser's version as Chrome/<version>", async () => {
    const { chrome } = await launched({});
    try {
      expect((chrome as unknown as { version: string }).version).toBe("Chrome/158.0.0.0");
    } finally {
      await chrome.close();
    }
  }, 30_000);
});
