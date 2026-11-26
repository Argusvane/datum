import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import agentGoldenText from "../../golden/agent-tools.json?raw";
import { compareToolDump, type AgentToolsFinding, type AgentToolsGolden } from "./agent-tools/compare.js";
import { HOST_USAGE, HostUsageError, parseHostArgs, type HostCheckArgs } from "./args.js";
import { CAPABILITY_NOTES } from "./capabilities.js";
import { CASES, caseById, moduleOf } from "./cases/index.js";
import { FIXTURE_FILES } from "./fixtures.js";
import { buildReport, renderReportJson, renderReportMarkdown } from "./report.js";
import { runHostCheck, selectCases, SelectionError, type CaseResult, type RunOutcome } from "./runner.js";
import { TargetError, targetFrom, type HostTarget } from "./target.js";
import type { RawRequest, RawResponse } from "./http.js";
import { CASE_SET_ID, KIT_NAME, KIT_VERSION } from "./version.js";

export interface HostCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface HostCliHooks {
  /** Replaced in tests: the HTTP transport (the default speaks node:http / node:https). */
  transport?: (request: RawRequest) => Promise<RawResponse>;
}

const processIo: HostCliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text)
};

/** Exit codes: the security suite's (src/exit-codes.ts), with 2 also meaning "a named capability asserted nothing". */
export const HOST_EXIT = { pass: 0, fail: 1, usage: 2, inconclusive: 3, internal: 4 } as const;

/** The whole command line as a function: arguments in, an exit code out. Never throws. */
export async function runHostCheckCli(argv: readonly string[], io: HostCliIo = processIo, hooks: HostCliHooks = {}): Promise<number> {
  try {
    const args = parseHostArgs(argv);
    switch (args.command) {
      case "help":
        io.stdout(HOST_USAGE);
        return HOST_EXIT.pass;
      case "version":
        io.stdout(`${KIT_NAME} ${KIT_VERSION} (case set ${CASE_SET_ID})\n`);
        return HOST_EXIT.pass;
      case "list":
        return list(args, io);
      case "explain":
        return explain(args, io);
      case "fixtures":
        return fixtures(args, io);
      case "agent-tools":
        return agentTools(args, io);
      case "run":
        return await run(args, io, hooks);
    }
  } catch (error) {
    if (error instanceof HostUsageError || error instanceof TargetError || error instanceof SelectionError) {
      io.stderr(`${KIT_NAME}: ${error.message}\n${error instanceof HostUsageError ? `${KIT_NAME} --help shows the options\n` : ""}`);
      return HOST_EXIT.usage;
    }
    io.stderr(`${KIT_NAME}: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return HOST_EXIT.internal;
  }
}

function list(args: HostCheckArgs, io: HostCliIo): number {
  if (args.json) {
    io.stdout(
      `${JSON.stringify(
        {
          kit: { name: KIT_NAME, version: KIT_VERSION, caseSet: CASE_SET_ID, caseCount: CASES.length },
          cases: CASES.map((entry) => ({ id: entry.id, capability: entry.capability, title: entry.title, order: entry.order, oracle: entry.oracle, expects: entry.expects }))
        },
        null,
        2
      )}\n`
    );
    return HOST_EXIT.pass;
  }
  const lines = ["ID       Capability        Title"];
  for (const entry of CASES) lines.push(`${entry.id.padEnd(8)} ${entry.capability.padEnd(17)} ${entry.title}`);
  const empty = Object.keys(CAPABILITY_NOTES).filter((capability) => moduleOf(capability as keyof typeof CAPABILITY_NOTES).cases.length === 0);
  if (empty.length > 0) lines.push("", `No cases yet: ${empty.join(", ")} (naming one exits 2).`);
  io.stdout(`${lines.join("\n")}\n`);
  return HOST_EXIT.pass;
}

function explain(args: HostCheckArgs, io: HostCliIo): number {
  const entry = caseById(args.id ?? "");
  if (entry === undefined) throw new HostUsageError(`no case ${args.id ?? ""}; "list" shows them`);
  const note = CAPABILITY_NOTES[entry.capability];
  const probes = moduleOf(entry.capability).probes;
  io.stdout(
    [
      `${entry.id}  ${entry.title}`,
      `  capability ${entry.capability}: ${note.holds}`,
      `  oracle ${entry.oracle} (@Order ${entry.order >= 1073741823 ? "Order.DEFAULT + 9000" : entry.order}) in integrations/jvm/tck/datum-host-tck`,
      `  sends and expects: ${entry.expects}`,
      `  the host needs: ${note.needs}`,
      ...probes.map((probe) => `  preflight ${probe.id}: ${probe.checks}`),
      "  every reply: no 5xx but a typed 503, and JSON on a JSON route (the never-5xx rule)",
      ""
    ].join("\n")
  );
  return HOST_EXIT.pass;
}

function fixtures(args: HostCheckArgs, io: HostCliIo): number {
  const dir = resolve(args.out as string);
  mkdirSync(dir, { recursive: true });
  for (const file of FIXTURE_FILES) {
    writeFileSync(join(dir, file.name), file.text);
    io.stdout(`wrote ${join(dir, file.name)}: ${file.what}\n`);
  }
  io.stdout(
    [
      "",
      "Spring Boot: add file:" + join(dir, "fixture-form.json") + " to datum.forms.locations for every capability that posts the fixture form.",
      "runtime-down (a test deployment): datum.runtime.programs.sandbox=file:" + join(dir, "stale-program.js") + " and datum.runtime.fail-fast=false.",
      "host-context (a test deployment): add file:" + join(dir, "fixture-host-context-form.json") + " to datum.forms.locations, switch the dry run on (datum.web.api.endpoints.test=true) and wire a test-only host context provider that answers {role: <X-Datum-Test-Role>} for datum-host-context.",
      ""
    ].join("\n")
  );
  return HOST_EXIT.pass;
}

/**
 * `agent-tools --tools <dump.json>`: a page's own tool dump against the shipped catalogue
 * (golden/agent-tools.json), with no endpoint and no engine. It is not a capability: CASES and the
 * Java kit's catalog stay as they are. A dump is the array getTools() or agentTools() gives, or an
 * object holding it as `tools`.
 */
function agentTools(args: HostCheckArgs, io: HostCliIo): number {
  const file = resolve(args.tools as string);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new HostUsageError(`cannot read --tools ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let dump: unknown;
  try {
    dump = JSON.parse(text);
  } catch (error) {
    throw new HostUsageError(`--tools ${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tools = Array.isArray(dump) ? dump : dump !== null && typeof dump === "object" && Array.isArray((dump as { tools?: unknown }).tools) ? ((dump as { tools: unknown[] }).tools) : undefined;
  if (tools === undefined) throw new HostUsageError(`--tools ${file} must hold an array of tools (getTools() or agentTools() as JSON)`);
  const golden = JSON.parse(agentGoldenText) as AgentToolsGolden;
  const findings = compareToolDump(golden, tools);
  if (args.json) {
    io.stdout(`${JSON.stringify({ kit: { name: KIT_NAME, version: KIT_VERSION }, golden: { toolsets: golden.toolsets }, findings }, null, 2)}\n`);
  } else if (findings.length === 0) {
    io.stdout(`${KIT_NAME} agent-tools: ${tools.length} tools match the catalogue (${golden.toolsets.form}, ${golden.toolsets.builder})\n`);
  } else {
    for (const finding of findings) io.stdout(`${findingLine(finding)}\n`);
    io.stdout(`${KIT_NAME} agent-tools: ${findings.length} finding${findings.length === 1 ? "" : "s"} against the catalogue (${golden.toolsets.form}, ${golden.toolsets.builder})\n`);
  }
  return findings.length === 0 ? HOST_EXIT.pass : HOST_EXIT.fail;
}

/** One finding as one line: kind, where, and the two values when there are any (cut at 160 characters each). */
function findingLine(finding: AgentToolsFinding): string {
  const where = `${finding.catalogue}${finding.tool !== undefined ? `/${finding.tool}` : ""}${finding.field !== undefined ? ` ${finding.field}` : ""}`;
  const show = (value: unknown): string => {
    const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "undefined");
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  };
  const values = "expected" in finding || "got" in finding ? `: expected ${show(finding.expected)}, got ${show(finding.got)}` : "";
  return `${finding.kind.padEnd(12)} ${where}${values}`;
}

async function run(args: HostCheckArgs, io: HostCliIo, hooks: HostCliHooks): Promise<number> {
  const target = targetFrom(args.properties);
  const selection = selectCases(target.capabilities, args.only, args.skip);
  io.stdout(`${KIT_NAME} ${KIT_VERSION} against ${target.baseUrl}: ${selection.capabilities.join(", ")}\n`);
  let group = "";
  const outcome = await runHostCheck({
    target,
    selection,
    ...(hooks.transport !== undefined ? { transport: hooks.transport } : {}),
    onPreflight: (preflight) => {
      for (const probe of preflight.probes) {
        if (probe.status !== "ok") io.stdout(`preflight ${probe.id}: ${probe.status.toUpperCase()} ${probe.message}\n`);
      }
    },
    onResult: (result: CaseResult) => {
      if (result.capability !== group) {
        group = result.capability;
        io.stdout(`== ${group}\n`);
      }
      io.stdout(`${result.status.padEnd(4)} ${result.id} ${result.title}${result.status === "PASS" ? "" : `\n     ${result.observed}`}\n`);
    }
  });
  summarize(target, outcome, io);
  if (args.out !== undefined) {
    const dir = resolve(args.out);
    try {
      const report = buildReport(target, outcome, args.argv);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.json"), renderReportJson(report));
      writeFileSync(join(dir, "report.md"), renderReportMarkdown(report));
      io.stdout(`wrote ${join(dir, "report.json")}\nwrote ${join(dir, "report.md")}\n`);
    } catch (error) {
      // The run's verdict is already on stdout and stands: a report folder that cannot be written
      // never turns a FAIL (1) or INCONCLUSIVE (3) into the command's own failure. Only a run that
      // passed ends 4, so a CI job that asked for the report does not go green without it.
      const reason = error instanceof Error ? error.message : String(error);
      io.stderr(`${KIT_NAME}: could not write the report under ${dir}: ${reason}\n`);
      return outcome.exitCode === HOST_EXIT.pass ? HOST_EXIT.internal : outcome.exitCode;
    }
  }
  return outcome.exitCode;
}

function summarize(target: HostTarget, outcome: RunOutcome, io: HostCliIo): void {
  for (const summary of outcome.capabilities) {
    io.stdout(`== ${summary.capability}: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped${summary.exercised || !outcome.preflight.ok ? "" : " (asserted nothing)"}\n`);
  }
  const pass = outcome.results.filter((result) => result.status === "PASS").length;
  const fail = outcome.results.filter((result) => result.status === "FAIL").length;
  const skip = outcome.results.filter((result) => result.status === "SKIP").length;
  io.stdout(`== ${outcome.verdict}: ${pass} passed, ${fail} failed, ${skip} skipped, ${outcome.requestsSent} requests to ${target.baseUrl} (exit ${outcome.exitCode})\n`);
  for (const reason of outcome.reasons) io.stdout(`   ${reason}\n`);
}
