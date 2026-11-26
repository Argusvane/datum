// The evaluation harness for the agent tools (not CI). Chromium with WebMCP on,
// driven through Playwright (scripts/playwright-driver.mjs), loads one of the
// pages under eval/ and lets a driver call the page's tools through document.modelContext, the
// way a browser agent would:
//
//   - scripted: a fixed tool-call list per task, no key. It proves the pages, the tools and the
//     checks work together, and is the harness's own smoke test;
//   - claude: the Messages API with tool use (plain fetch, no SDK, no dependency), the key read
//     from ANTHROPIC_API_KEY and from nowhere else. Built and tested over a stubbed fetch; not
//     run against the API.
//
// Three tasks (fill a travel claim from a paragraph, summarise a half-filled one, build an event
// form and test one of its rules), each judged by checks run through the same page afterwards.
// One transcript per run, <out>/<task>-<driver>-<n>.json, never overwritten.
//
//   node scripts/agent-eval.mjs [--task fill|summarise|build|all] [--driver scripted|claude]
//                               [--runs N] [--model ID] [--effort low|medium|high] [--no-fallbacks]
//                               [--max-turns N] [--out DIR] [--port N] [--headed]
//
// Exit codes: 0 every run passed its checks; 1 a run failed one; 2 usage; 3 environment (no
// Chromium, no dist/, WebMCP off in this Chrome); 4 internal. A $CHROME that is set but names no binary is an
// environment error too (exit 3, the path in the message): it is never worked around. Needs `npm run build` first (it
// loads dist/). The module exports its pure parts (argument parsing, the scripted steps, the
// turn loop over an injected fetch and an injected tool runner, transcript naming, the checks)
// and runs main() only when started as a script.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launch, packageRoot, sortKeys, waitFor } from "./playwright-driver.mjs";

/** The model a claude run uses when --model is not given. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_TURNS = 40;
export const DEFAULT_PORT = 4177;
export const DEFAULT_OUT = join(tmpdir(), "datum-agent-evals");

/** The system prompt both drivers record; the claude driver sends it. */
export const SYSTEM_PROMPT =
  "You are an assistant in the person's web browser. The page offers tools for the form on it; use them to do what the person asks, and nothing they did not ask for. When you are done, answer the person in a few sentences.";

/** What a consequential call answers: the browser would have asked the person, and the person said no. */
export const DECLINE_TEXT = "The browser asked the person to confirm this action and they declined.";

/** The message a claude run without a key stops with (exit 2), before Chrome is launched. */
export const NO_KEY_MESSAGE =
  "agent-eval: --driver claude needs ANTHROPIC_API_KEY in the environment (read from there only, never stored or logged). Use --driver scripted for the key-free run.";

export const USAGE = `usage: node scripts/agent-eval.mjs [--task fill|summarise|build|all] [--driver scripted|claude]
                              [--runs N] [--model ID] [--effort low|medium|high] [--no-fallbacks]
                              [--max-turns N] [--out DIR] [--port N] [--headed]`;

const TASK_NAMES = ["fill", "summarise", "build"];
const DRIVERS = ["scripted", "claude"];
const EFFORTS = ["low", "medium", "high"];
const CALL_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 180_000;
const API_URL = "https://api.anthropic.com/v1/messages";
const RETRYABLE_STATUS = new Set([429, 500, 529]);
const MAX_RETRIES = 3;

/** Per task: the page, the element the checks read, the prompt (exact) and the scripted run's closing words. */
export const TASKS = {
  fill: {
    page: "/eval/form.html",
    element: "#claim",
    prompt:
      "Ana Silva (ana.silva@example.org) travelled to Ottawa for a client workshop from 3 to 5 March 2026. She paid 412.50 for the train and 389.00 for two hotel nights. Please fill in her travel claim on this page, but leave the declaration for her to tick, and do not submit it.",
    scriptedFinal: "I filled in the claim and left the declaration for you to tick."
  },
  summarise: {
    page: "/eval/form.html?prefill=half",
    element: "#claim",
    prompt: "What is still missing on this form, and does anything look wrong? Please don't change anything.",
    scriptedFinal: "Still missing: the email and the declaration. The return date is before the departure date."
  },
  build: {
    page: "/eval/builder.html",
    element: "#builder",
    prompt:
      "Build an event registration form with: name (required), email (required), number of guests from 1 to 5, and a 'Dietary needs' text box that only shows when there is more than one guest. Then add a test that checks the dietary box shows with 2 guests, and run it.",
    scriptedFinal: "I built the form and added a test that passes."
  }
};

// --- arguments ---------------------------------------------------------------------------------

function positiveInteger(text) {
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : undefined;
}

/**
 * Reads the command line. `{ ok: true, options }`, or `{ ok: false, message }` for an unknown
 * flag, a missing or bad value (the caller prints the message and the usage and exits 2), or
 * `{ ok: true, help: true }` for --help.
 */
export function parseArgs(argv, env = {}) {
  const options = {
    task: "all",
    driver: "scripted",
    runs: 1,
    model: DEFAULT_MODEL,
    effort: undefined,
    fallbacks: true,
    maxTurns: DEFAULT_MAX_TURNS,
    out: DEFAULT_OUT,
    port: positiveInteger(String(env.PORT ?? "")) ?? DEFAULT_PORT,
    headed: false
  };
  const withValue = new Set(["--task", "--driver", "--runs", "--model", "--effort", "--max-turns", "--out", "--port"]);
  for (let index = 0; index < argv.length; index += 1) {
    let flag = argv[index];
    let value;
    const equals = flag.indexOf("=");
    if (flag.startsWith("--") && equals > 0) {
      value = flag.slice(equals + 1);
      flag = flag.slice(0, equals);
    }
    if (flag === "--help" || flag === "-h") {
      return { ok: true, help: true };
    }
    if (flag === "--no-fallbacks") {
      options.fallbacks = false;
      continue;
    }
    if (flag === "--headed") {
      options.headed = true;
      continue;
    }
    if (!withValue.has(flag)) {
      return { ok: false, message: `agent-eval: unknown argument ${JSON.stringify(argv[index])}` };
    }
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || (value.startsWith("--") && flag !== "--out")) {
      return { ok: false, message: `agent-eval: ${flag} needs a value` };
    }
    switch (flag) {
      case "--task":
        if (value !== "all" && !TASK_NAMES.includes(value)) {
          return { ok: false, message: `agent-eval: --task is one of fill, summarise, build, all (got ${JSON.stringify(value)})` };
        }
        options.task = value;
        break;
      case "--driver":
        if (!DRIVERS.includes(value)) {
          return { ok: false, message: `agent-eval: --driver is scripted or claude (got ${JSON.stringify(value)})` };
        }
        options.driver = value;
        break;
      case "--runs": {
        const runs = positiveInteger(value);
        if (runs === undefined) {
          return { ok: false, message: `agent-eval: --runs is a whole number from 1 (got ${JSON.stringify(value)})` };
        }
        options.runs = runs;
        break;
      }
      case "--model":
        options.model = value;
        break;
      case "--effort":
        if (!EFFORTS.includes(value)) {
          return { ok: false, message: `agent-eval: --effort is one of low, medium, high (got ${JSON.stringify(value)})` };
        }
        options.effort = value;
        break;
      case "--max-turns": {
        const turns = positiveInteger(value);
        if (turns === undefined) {
          return { ok: false, message: `agent-eval: --max-turns is a whole number from 1 (got ${JSON.stringify(value)})` };
        }
        options.maxTurns = turns;
        break;
      }
      case "--out":
        options.out = value;
        break;
      case "--port": {
        const port = positiveInteger(value);
        if (port === undefined || port > 65535) {
          return { ok: false, message: `agent-eval: --port is a port number (got ${JSON.stringify(value)})` };
        }
        options.port = port;
        break;
      }
    }
  }
  return { ok: true, options };
}

/** The tasks a run list names, in the order fill, summarise, build. */
export function tasksOf(task) {
  return task === "all" ? [...TASK_NAMES] : [task];
}

// --- transcripts -------------------------------------------------------------------------------

/** One more than the highest `<task>-<driver>-<n>.json` already in `dir` (1 when none, or no folder). */
export function nextRunNumber(dir, task, driver) {
  let highest = 0;
  if (existsSync(dir)) {
    const pattern = new RegExp(`^${task}-${driver}-([0-9]+)\\.json$`);
    for (const name of readdirSync(dir)) {
      const match = pattern.exec(name);
      if (match !== null) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
  }
  return highest + 1;
}

export function transcriptPath(dir, task, driver, run) {
  return join(dir, `${task}-${driver}-${run}.json`);
}

/** Replaces every occurrence of a secret in a text; a key shorter than 8 characters is not treated as one. */
export function scrub(text, secret) {
  return typeof secret === "string" && secret.length >= 8 ? text.split(secret).join("[redacted]") : text;
}

/** Writes the transcript under the next free number and returns its path (the key never reaches the file). */
export function writeTranscript(dir, transcript, secret) {
  mkdirSync(dir, { recursive: true });
  const run = nextRunNumber(dir, transcript.task, transcript.driver);
  const path = transcriptPath(dir, transcript.task, transcript.driver, run);
  writeFileSync(path, scrub(`${JSON.stringify({ ...transcript, run }, null, 2)}\n`, secret));
  return { path, run };
}

// --- tools and calls ---------------------------------------------------------------------------

/** The Messages API's shape of the page's tools: name, description and schema as they are; title and annotations stay in the transcript. */
export function translateTools(tools) {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}

/**
 * What the transcript keeps of the page's tools: names, the hash of what the API was sent, and
 * (contract 8.6) the titles and annotations that are not sent, so a later reader sees which tools
 * the run treated as consequential or read-only without rebuilding them from a newer dist. The
 * annotations are the browser's merged with the element's (`annotationsOf`, which carries
 * consequentialHint); the hash stays over translateTools alone.
 */
export function toolsRecord(tools, toolset, annotationsOf = () => undefined) {
  const names = tools.map((tool) => tool.name);
  return {
    count: tools.length,
    ...(toolset === undefined ? {} : { toolset }),
    names,
    entries: tools.map((tool) => ({ name: tool.name, title: tool.title ?? null, annotations: { ...(tool.annotations ?? {}), ...(annotationsOf(tool.name) ?? {}) } })),
    sha256: createHash("sha256").update(JSON.stringify(translateTools(tools))).digest("hex")
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} took longer than ${ms / 1000} s`);
      error.timedOut = true;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one tool call through the runner and reads the envelope. `rejected` is a call the browser
 * rejected or that took longer than 30 s (including the opaque UnknownError); a
 * refusal is a normal envelope with `ok: false`.
 */
export async function runCall(runner, name, input, timeoutMs = CALL_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const text = await withTimeout(Promise.resolve(runner.call(name, input)), timeoutMs, `the call to ${name}`);
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = undefined;
    }
    return { rejected: false, text: String(text), envelope, ok: envelope?.ok === true, ms: Date.now() - started };
  } catch (error) {
    return { rejected: true, text: error instanceof Error ? error.message : String(error), ok: false, ms: Date.now() - started, timedOut: error?.timedOut === true };
  }
}

/** Whether the browser would have asked the person: the tool's own consequentialHint. */
export function isConsequential(runner, name) {
  return runner.annotationsOf(name)?.consequentialHint === true;
}

/**
 * One tool call of a run, declined or executed, as the transcript records it plus what the
 * driver sends back. Executed calls are appended to `run.executed` for the checks.
 */
async function performCall(run, runner, id, name, input) {
  if (isConsequential(runner, name)) {
    run.declined += 1;
    return { entry: { id, name, input, declined: true }, content: DECLINE_TEXT, isError: true };
  }
  const outcome = await runCall(runner, name, input);
  if (run.toolset === undefined && typeof outcome.envelope?.toolset === "string") {
    run.toolset = outcome.envelope.toolset;
  }
  if (outcome.rejected) {
    // A call the browser rejected (an unknown tool name, a timeout) ran nothing, so it is not an
    // executed call: summarise.unchanged reads `executed` for write tools (contract 8.8).
    return { entry: { id, name, input, ms: outcome.ms, ok: false, error: outcome.text }, content: outcome.text, isError: true };
  }
  run.executed.push({ name, annotations: runner.annotationsOf(name) ?? {} });
  if (!outcome.ok) {
    run.refusals += 1;
  }
  return { entry: { id, name, input, ms: outcome.ms, ok: outcome.ok, ...(outcome.envelope === undefined ? { raw: outcome.text } : { result: outcome.envelope }) }, content: outcome.text, isError: false };
}

function newRun() {
  return { executed: [], declined: 0, refusals: 0, toolset: undefined };
}

// --- the scripted driver -----------------------------------------------------------------------

const EVENT_FORM_COMPONENTS = [
  { type: "text", id: "name", label: "Name", required: true },
  { type: "text", id: "email", label: "Email", required: true },
  { type: "number", id: "guests", label: "Number of guests", required: true, configuration: { min: 1, max: 5 } },
  { type: "textarea", id: "dietary", label: "Dietary needs", rules: { visibleWhen: "guests > 1" } }
];

const DIETARY_TEST = `test "dietary needs show with two guests"
  set guests = 2
  expect dietary visible`;

/** A fixed list of { tool, input, expect? } per task (contract 8.5); `expect` is a refusal code the step must answer. */
export function scriptedSteps(task) {
  switch (task) {
    case "fill":
      return [
        { tool: "describe_form", input: { scope: "all" } },
        {
          tool: "set_answers",
          input: {
            answers: {
              fullName: "Ana Silva",
              email: "ana.silva@example.org",
              purpose: "Client work",
              departure: "2026-03-03",
              return: "2026-03-05",
              costs: [
                { description: "Train", amount: 412.5 },
                { description: "Hotel, two nights", amount: 389 }
              ]
            }
          }
        },
        { tool: "edit_rows", input: { collection: "costs", action: "add" } },
        { tool: "edit_rows", input: { collection: "costs", action: "remove", index: 2 } },
        { tool: "check", input: {} }
      ];
    case "summarise":
      return [
        { tool: "describe_form", input: { scope: "all" } },
        { tool: "get_answers", input: { scope: "all", includeEmpty: true } },
        { tool: "check", input: {} }
      ];
    case "build":
      return [
        { tool: "describe_builder", input: {} },
        { tool: "add_components", input: { components: EVENT_FORM_COMPONENTS } },
        { tool: "check_form", input: {} },
        { tool: "write_test", input: { source: DIETARY_TEST } },
        { tool: "run_tests", input: {} }
      ];
    default:
      throw new Error(`agent-eval: no scripted steps for the task ${JSON.stringify(task)}`);
  }
}

/** Runs the steps in order (`steps` stands in for the task's list in tests); aborts at the first result with ok false unless the step expected that code. */
export async function runScripted({ task, runner, now = () => new Date(), steps = scriptedSteps(task) }) {
  const run = newRun();
  const turns = [];
  let end = "done";
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const outcome = await performCall(run, runner, `step-${index + 1}`, step.tool, step.input);
    turns.push({ turn: index + 1, stopReason: "tool_use", text: "", calls: [outcome.entry] });
    const code = outcome.entry.result?.code;
    const expected = step.expect;
    const passed = expected === undefined ? outcome.entry.ok === true : outcome.entry.ok === false && code === expected;
    if (!passed) {
      end = "step-failed";
      break;
    }
  }
  const text = end === "done" ? TASKS[task].scriptedFinal : "";
  return {
    run,
    turns,
    final: { stopReason: end === "done" ? "end_turn" : "step-failed", text },
    end,
    servedBy: [],
    fallbackRan: false,
    endedAt: now().toISOString()
  };
}

// --- the Claude driver -------------------------------------------------------------------------

/** The request body of one turn: no sampling parameters, no thinking field, no forced tool choice. */
export function buildRequestBody({ model, tools, messages, effort, fallbacks }) {
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools,
    messages,
    ...(effort ? { output_config: { effort } } : {}),
    ...(fallbacks ? { fallbacks: "default" } : {})
  };
}

/** The headers of one turn; the key is read by the caller from the environment and goes nowhere else. */
export function buildRequestHeaders({ apiKey, fallbacks }) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2026-10-21",
    "content-type": "application/json",
    ...(fallbacks ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {})
  };
}

/**
 * Posts one request, retrying 429, 500, 529 and network errors up to three times (the
 * retry-after header, else 2, 4 and 8 s). Resolves to `{ ok: true, body }` or
 * `{ ok: false, status, type, message }`; never rejects, and never carries a header.
 */
export async function postMessages({ fetchImpl, apiKey, body, fallbacks, sleep }) {
  let last;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(API_URL, {
        method: "POST",
        headers: buildRequestHeaders({ apiKey, fallbacks }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
    } catch (error) {
      last = { ok: false, status: 0, type: "network-error", message: scrub(error instanceof Error ? error.message : String(error), apiKey) };
      if (attempt < MAX_RETRIES) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return last;
    }
    if (response.ok) {
      return { ok: true, body: await response.json() };
    }
    const failure = await response.json().catch(() => ({}));
    last = { ok: false, status: response.status, type: failure?.error?.type ?? "unknown", message: scrub(String(failure?.error?.message ?? ""), apiKey) };
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      const header = Number.parseFloat(response.headers?.get?.("retry-after") ?? "");
      await sleep(Number.isFinite(header) && header >= 0 ? header * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    return last;
  }
  return last;
}

function textOf(content) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * The model loop (contract 8.6): the whole response.content is the assistant turn (thinking
 * blocks unchanged); tool_use runs every block in order and answers with one user message of
 * tool_results; pause_turn is sent again as it stands; end_turn is the final text; max_tokens
 * ends the run truncated; refusal ends it refused with the stop details' category.
 */
export async function runClaude({ runner, tools, prompt, model, effort, fallbacks, maxTurns, fetchImpl, apiKey, sleep, now = () => new Date() }) {
  const run = newRun();
  const translated = translateTools(tools);
  const messages = [{ role: "user", content: prompt }];
  const turns = [];
  const servedBy = [];
  let fallbackRan = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let end;
  let final = { stopReason: "none", text: "" };
  let error;
  let modelTurns = 0;
  while (end === undefined) {
    if (modelTurns >= maxTurns) {
      end = "max-turns";
      break;
    }
    const reply = await postMessages({ fetchImpl, apiKey, body: buildRequestBody({ model, tools: translated, messages, effort, fallbacks }), fallbacks, sleep });
    if (!reply.ok) {
      end = "api-error";
      error = { status: reply.status, type: reply.type, message: reply.message };
      break;
    }
    modelTurns += 1;
    const response = reply.body;
    const content = Array.isArray(response.content) ? response.content : [];
    const served = typeof response.model === "string" ? response.model : model;
    if (!servedBy.includes(served)) {
      servedBy.push(served);
    }
    if (served !== model || (response.usage?.iterations ?? []).some((entry) => entry?.type === "fallback_message")) {
      fallbackRan = true;
    }
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    const turn = {
      turn: modelTurns,
      stopReason: response.stop_reason,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
      servedBy: served,
      text: textOf(content),
      calls: []
    };
    turns.push(turn);
    messages.push({ role: "assistant", content });
    switch (response.stop_reason) {
      case "tool_use": {
        const results = [];
        for (const block of content.filter((entry) => entry.type === "tool_use")) {
          const outcome = await performCall(run, runner, block.id, block.name, block.input ?? {});
          turn.calls.push(outcome.entry);
          results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        break;
      }
      case "pause_turn":
        break;
      case "max_tokens":
        final = { stopReason: "max_tokens", text: turn.text };
        end = "truncated";
        break;
      case "refusal":
        final = { stopReason: "refusal", text: turn.text, category: response.stop_details?.category ?? null };
        end = "refused";
        break;
      default:
        final = { stopReason: response.stop_reason ?? "end_turn", text: turn.text };
        end = "done";
    }
  }
  return { run, turns, final, end, servedBy, fallbackRan, inputTokens, outputTokens, ...(error === undefined ? {} : { error }), endedAt: now().toISOString() };
}

// --- checks ------------------------------------------------------------------------------------

function sameJson(left, right) {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

/**
 * The rows of a collection in `element.values`, which keys them by path (`costs[0].amount`); a nested array under the collection's own name reads the same.
 */
export function rowsOf(values, name) {
  if (Array.isArray(values?.[name])) {
    return values[name];
  }
  const rows = [];
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[([0-9]+)\\]\\.(.+)$`);
  for (const [key, value] of Object.entries(values ?? {})) {
    const match = pattern.exec(key);
    if (match !== null) {
      const index = Number(match[1]);
      rows[index] = { ...rows[index], [match[2]]: value };
    }
  }
  return rows.filter((row) => row !== undefined);
}

/** fill: the values written, the declaration left, no submit, and check reports only the declaration. */
export function fillChecks({ values, submits, executed, check }) {
  const costs = rowsOf(values, "costs");
  const amounts = costs.map((row) => Number(row?.amount)).sort((a, b) => a - b);
  const conditions = [
    values?.fullName === "Ana Silva",
    values?.email === "ana.silva@example.org",
    values?.purpose === "client",
    values?.departure === "2026-03-03",
    values?.return === "2026-03-05",
    costs.length === 2 && amounts[0] === 389 && amounts[1] === 412.5,
    costs.length === 2 && costs.every((row) => typeof row?.description === "string" && row.description.trim() !== "")
  ];
  const errors = Array.isArray(check?.errors) ? check.errors : [];
  const blockingElsewhere = errors.filter((entry) => (entry?.id ?? entry?.path) !== "declaration");
  return [
    { id: "fill.values", passed: conditions.every(Boolean), detail: `${conditions.filter(Boolean).length} of ${conditions.length}` },
    { id: "fill.declaration", passed: values?.declaration !== true, detail: `declaration is ${JSON.stringify(values?.declaration ?? null)}` },
    { id: "fill.no-submit", passed: submits === 0 && !executed.some((call) => call.name === "submit"), detail: `${submits} submit event(s)` },
    { id: "fill.check", passed: check?.ok === true && blockingElsewhere.length === 0, detail: check?.ok === true ? `${errors.length} blocking, ${blockingElsewhere.length} besides the declaration` : "check did not answer ok" }
  ];
}

/** summarise: nothing changed and no write tool ran, and the closing text names what the claim lacks. */
export function summariseChecks({ before, after, executed, finalText }) {
  const wrote = executed.filter((call) => call.annotations?.readOnlyHint !== true).map((call) => call.name);
  const text = String(finalText ?? "").toLowerCase();
  const missing = ["email", "declaration", "return"].filter((word) => !text.includes(word));
  return [
    { id: "summarise.unchanged", passed: sameJson(before, after) && wrote.length === 0, detail: wrote.length === 0 ? "values equal, no write tool" : `write tools run: ${wrote.join(", ")}` },
    { id: "summarise.mentions", passed: missing.length === 0, detail: missing.length === 0 ? "email, declaration, return" : `missing ${missing.join(", ")}` }
  ];
}

function nodeNamed(nodes, pattern, accept = () => true) {
  return nodes.find((node) => typeof node?.label === "string" && pattern.test(node.label) && accept(node));
}

/** build: the form the description asks for, a clean check_form, a passing test that names the dietary field, no save. */
export function buildChecks({ form, formCheck, tests, runResult, executed }) {
  const nodes = Array.isArray(form?.nodes) ? form.nodes : [];
  const name = nodeNamed(nodes, /name/i, (node) => node.required === true);
  const email = nodeNamed(nodes, /e-?mail/i, (node) => node.required === true);
  const guests = nodeNamed(nodes, /guest/i, (node) => Number(node.configuration?.min) === 1 && Number(node.configuration?.max) === 5);
  const dietary = nodeNamed(nodes, /dietar/i);
  const guestsId = guests?.id;
  const reads = guestsId !== undefined && typeof dietary?.rulesText?.visibleWhen === "string" && new RegExp(`(^|[^A-Za-z0-9_])${guestsId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(dietary.rulesText.visibleWhen);
  const found = { name: name !== undefined, email: email !== undefined, guests: guests !== undefined, dietary: dietary !== undefined && reads };
  const missing = Object.entries(found).filter(([, ok]) => !ok).map(([key]) => key);
  const sources = new Map((Array.isArray(tests?.tests) ? tests.tests : []).map((entry) => [entry.id, String(entry.source ?? "")]));
  const dietaryId = dietary?.id;
  const results = Array.isArray(runResult?.results) ? runResult.results : [];
  const passing = results.filter((entry) => entry?.status === "passed" && dietaryId !== undefined && (sources.get(entry.id) ?? "").includes(dietaryId));
  return [
    { id: "build.fields", passed: missing.length === 0, detail: missing.length === 0 ? "name, email, guests, dietary" : `missing ${missing.join(", ")}` },
    { id: "build.clean", passed: formCheck?.ok === true && formCheck?.counts?.errors === 0, detail: `${formCheck?.counts?.errors ?? "?"} error(s)` },
    { id: "build.test", passed: passing.length >= 1, detail: `${passing.length} passing test(s) naming ${dietaryId ?? "the dietary field"}` },
    { id: "build.no-save", passed: !executed.some((call) => call.name === "save"), detail: "no save call" }
  ];
}

// --- the page ----------------------------------------------------------------------------------

/** The recipe of the real-browser notes: every snippet goes through eval inside a function. */
export function wrapSnippet(snippet) {
  return `(function(){ return eval(${JSON.stringify(snippet)}) })()`;
}

class EnvironmentError extends Error {}

function parseSchema(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** The runner over one page: the browser's own tool list and executeTool, the element for annotations and checks. */
export function pageRunner(page, element) {
  const selector = JSON.stringify(element);
  const evaluate = (snippet) => page.evaluate(wrapSnippet(snippet));
  const annotations = new Map();
  return {
    async list() {
      const tools = await evaluate(
        "(async () => (await document.modelContext.getTools()).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })))()"
      );
      return tools.map((tool) => ({ ...tool, inputSchema: parseSchema(tool.inputSchema) }));
    },
    // The browser keeps only its own annotation keys, so the harness reads the element's (they carry consequentialHint).
    async loadAnnotations() {
      const entries = await evaluate(`(async () => (await document.querySelector(${selector}).agentTools()).map((t) => [t.name, t.annotations ?? {}]))()`);
      annotations.clear();
      for (const [name, value] of entries) {
        annotations.set(name, value);
      }
    },
    annotationsOf: (name) => annotations.get(name),
    call(name, input) {
      return evaluate(
        `(async () => { const mc = document.modelContext; const tool = (await mc.getTools()).find((t) => t.name === ${JSON.stringify(name)}); if (!tool) throw new Error("no tool named " + ${JSON.stringify(name)}); return await mc.executeTool(tool, ${JSON.stringify(input)}); })()`
      );
    },
    values: async () => JSON.parse(await evaluate(`JSON.stringify(document.querySelector(${selector}).values ?? {})`)),
    submits: async () => Number(await evaluate("window.__evalSubmits ?? 0")),
    // The checks read from the host side (contract 8.8): the element's own executeAgentTool(), not
    // the browser channel the agent's calls go through, so they never look like the assistant's.
    async envelope(name, input) {
      try {
        const text = await withTimeout(
          Promise.resolve(evaluate(`(async () => JSON.stringify(await document.querySelector(${selector}).executeAgentTool(${JSON.stringify(name)}, ${JSON.stringify(input)})))()`)),
          CALL_TIMEOUT_MS,
          `the check call to ${name}`
        );
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }
  };
}

async function openTaskPage(chrome, taskName) {
  const task = TASKS[taskName];
  const page = await chrome.open(task.page);
  const hasModelContext = await page.evaluate(wrapSnippet('typeof document.modelContext?.getTools === "function"'));
  if (hasModelContext !== true) {
    page.close();
    throw new EnvironmentError(`agent-eval: WebMCP is not on in this Chrome (Chrome 155 or later with --enable-features=WebMCP); ${chrome.version}`);
  }
  const runner = pageRunner(page, task.element);
  if (taskName !== "build") {
    await waitFor(() => page.evaluate("window.__evalReady === true"), { what: `${task.page} to finish its script`, who: "agent-eval" });
  }
  await waitFor(async () => (await runner.list()).length > 0, { what: "the page to register its tools", who: "agent-eval", timeoutMs: 30_000 });
  if (taskName === "build") {
    await waitFor(() => page.evaluate(wrapSnippet(`document.querySelector(${JSON.stringify(task.element)}).agentBuildState === "ready"`)), { what: "the builder to be ready", who: "agent-eval", timeoutMs: 30_000 });
  }
  await runner.loadAnnotations();
  return { page, runner };
}

/** Runs the checks of a task on the live page after the driver is done. */
async function checksFor(taskName, runner, outcome, before) {
  const executed = outcome.run.executed;
  if (taskName === "fill") {
    const check = await runner.envelope("check", { scope: "form" });
    return fillChecks({ values: await runner.values(), submits: await runner.submits(), executed, check });
  }
  if (taskName === "summarise") {
    return summariseChecks({ before, after: await runner.values(), executed, finalText: outcome.final.text });
  }
  const form = await runner.envelope("get_form", { detail: "full", limit: 1000 });
  const formCheck = await runner.envelope("check_form", {});
  const tests = await runner.envelope("list_tests", {});
  const runResult = await runner.envelope("run_tests", {});
  return buildChecks({ form, formCheck, tests, runResult, executed });
}

// --- main --------------------------------------------------------------------------------------

function transcriptOf({ taskName, driver, options, chrome, tools, runner, outcome, checks, startedAt }) {
  const calls = outcome.turns.flatMap((turn) => turn.calls);
  const passed = outcome.end === "done" && checks.every((check) => check.passed);
  return {
    version: 1,
    task: taskName,
    driver,
    run: 0,
    startedAt,
    endedAt: outcome.endedAt,
    chrome: String(chrome.version).replace(/^Chrome\//, ""),
    page: TASKS[taskName].page,
    ...(driver === "claude" ? { model: options.model } : {}),
    servedBy: outcome.servedBy,
    fallbackRan: outcome.fallbackRan,
    system: SYSTEM_PROMPT,
    prompt: TASKS[taskName].prompt,
    tools: toolsRecord(tools, outcome.run.toolset, (name) => runner.annotationsOf(name)),
    turns: outcome.turns,
    final: outcome.final,
    end: outcome.end,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    success: { passed, checks },
    totals: {
      turns: outcome.turns.length,
      calls: calls.length,
      refusals: outcome.run.refusals,
      declined: outcome.run.declined,
      inputTokens: outcome.inputTokens ?? 0,
      outputTokens: outcome.outputTokens ?? 0
    }
  };
}

/**
 * The whole command. Returns the exit code (the caller sets process.exitCode), so Chrome and the
 * server are closed in a finally on every path. `deps` stands in for the outside world in tests:
 * launch, fetch, sleep, the environment, the output streams and the package folder.
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((line) => console.log(line));
  const err = deps.stderr ?? ((line) => console.error(line));
  const root = deps.packageRoot ?? packageRoot;
  const parsed = parseArgs(argv, env);
  if (!parsed.ok) {
    err(parsed.message);
    err(USAGE);
    return 2;
  }
  if (parsed.help) {
    out(USAGE);
    return 0;
  }
  const options = parsed.options;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (options.driver === "claude" && !apiKey) {
    err(NO_KEY_MESSAGE);
    return 2;
  }
  for (const bundle of ["datum-form.js", "datum-builder.js"]) {
    if (!existsSync(join(root, "dist", bundle))) {
      err(`agent-eval: dist/${bundle} is missing, run \`npm run build\` first`);
      return 3;
    }
  }
  let chrome;
  let code = 0;
  try {
    chrome = await (deps.launch ?? launch)({ serverPort: options.port, who: "agent-eval", readyPath: "/eval/index.html", chromeArgs: ["--enable-features=WebMCP"], headless: !options.headed });
    for (const taskName of tasksOf(options.task)) {
      for (let attempt = 0; attempt < options.runs; attempt += 1) {
        const startedAt = new Date().toISOString();
        const { page, runner } = await openTaskPage(chrome, taskName);
        try {
          const tools = await runner.list();
          const before = taskName === "summarise" ? await runner.values() : undefined;
          const outcome =
            options.driver === "scripted"
              ? await runScripted({ task: taskName, runner })
              : await runClaude({
                  runner,
                  tools,
                  prompt: TASKS[taskName].prompt,
                  model: options.model,
                  effort: options.effort,
                  fallbacks: options.fallbacks,
                  maxTurns: options.maxTurns,
                  fetchImpl: deps.fetch ?? fetch,
                  apiKey,
                  sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
                });
          const checks = await checksFor(taskName, runner, outcome, before);
          const transcript = transcriptOf({ taskName, driver: options.driver, options, chrome, tools, runner, outcome, checks, startedAt });
          const written = writeTranscript(options.out, transcript, apiKey);
          out(`agent-eval: ${taskName} ${options.driver} run ${written.run}: ${outcome.end}, ${transcript.success.passed ? "passed" : "FAILED"} (${checks.filter((check) => check.passed).length}/${checks.length} checks) ${written.path}`);
          if (!transcript.success.passed) {
            for (const check of checks.filter((entry) => !entry.passed)) {
              out(`  failed ${check.id}: ${check.detail}`);
            }
            code = Math.max(code, 1);
          }
        } finally {
          await page.close();
        }
      }
    }
  } catch (error) {
    if (error instanceof EnvironmentError || /: no Chrom(?:e|ium) found/.test(error instanceof Error ? error.message : "")) {
      // No Chromium (or $CHROME naming a missing binary) is the machine, not a harness bug: exit 3, no stack.
      err(error.message);
      code = 3;
    } else {
      err(`agent-eval: ${scrub(error instanceof Error ? (error.stack ?? error.message) : String(error), apiKey)}`);
      code = 4;
    }
  } finally {
    await chrome?.close();
  }
  return code;
}

function startedAsScript() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`agent-eval: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 4;
    }
  );
}
