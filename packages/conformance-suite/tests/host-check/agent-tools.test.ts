import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AgentToolsGolden } from "../../src/host-check/agent-tools/compare.js";
import { parseHostArgs, runHostCheckCli } from "../../src/host-check/index.js";
import { CASES } from "../../src/host-check/cases/index.js";
import { PACKAGE_ROOT } from "../helpers/paths.js";

/** `datum-host-check agent-tools --tools <dump.json>`: engine-free, no endpoint. */
const golden = JSON.parse(readFileSync(join(PACKAGE_ROOT, "golden", "agent-tools.json"), "utf8")) as AgentToolsGolden;
const work = mkdtempSync(join(tmpdir(), "datum-agent-tools-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function dumpOf(mutate: (tools: Record<string, unknown>[]) => Record<string, unknown>[] = (tools) => tools): string {
  const tools = [...golden.form, ...golden.session].map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
  const file = join(work, `dump-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(mutate(tools)));
  return file;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runHostCheckCli(argv, { stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
  return { code, out, err };
}

describe("datum-host-check agent-tools", () => {
  it("exits 0 for a dump made from the golden", async () => {
    const result = await cli("agent-tools", "--tools", dumpOf());
    expect(result.code).toBe(0);
    expect(result.out).toContain("14 tools match the catalogue (datum-form/1, datum-builder/1)");
    expect(result.err).toBe("");
  });

  it("reads the object form of a dump, `{ tools: [...] }`", async () => {
    const file = join(work, "wrapped.json");
    writeFileSync(file, JSON.stringify({ tools: JSON.parse(readFileSync(dumpOf(), "utf8")) }));
    expect((await cli("agent-tools", "--tools", file)).code).toBe(0);
  });

  it("exits 1 with one line per finding when a description changed", async () => {
    const file = dumpOf((tools) => tools.map((tool) => (tool["name"] === "get_answers" ? { ...tool, description: "Changed." } : tool)));
    const result = await cli("agent-tools", "--tools", file);
    expect(result.code).toBe(1);
    const lines = result.out.trim().split("\n");
    expect(lines[0]).toMatch(/^description\s+form\/get_answers: expected ".*, got "Changed\."$/);
    expect(lines[1]).toContain("1 finding against the catalogue");
    expect(lines).toHaveLength(2);
  });

  it("names a missing tool", async () => {
    const result = await cli("agent-tools", "--tools", dumpOf((tools) => tools.filter((tool) => tool["name"] !== "submit")));
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^missing-tool\s+form\/submit/m);
  });

  it("exits 2 with no --tools, a missing file, a file that is not JSON and one that is not a tool list", async () => {
    expect((await cli("agent-tools")).code).toBe(2);
    const missing = await cli("agent-tools", "--tools", join(work, "nope.json"));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("cannot read --tools");
    const notJson = join(work, "text.json");
    writeFileSync(notJson, "not json");
    expect((await cli("agent-tools", "--tools", notJson)).code).toBe(2);
    const notList = join(work, "object.json");
    writeFileSync(notList, '{"a":1}');
    const result = await cli("agent-tools", "--tools", notList);
    expect(result.code).toBe(2);
    expect(result.err).toContain("must hold an array of tools");
    expect(result.err).not.toContain("internal error");
  });

  it("refuses --tools on any other command", async () => {
    expect((await cli("list", "--tools", dumpOf())).code).toBe(2);
  });

  it("--json prints { kit, golden: { toolsets }, findings }", async () => {
    const clean = JSON.parse((await cli("agent-tools", "--tools", dumpOf(), "--json")).out) as { kit: { name: string }; golden: { toolsets: unknown }; findings: unknown[] };
    expect(clean.kit.name).toBe("datum-host-check");
    expect(clean.golden.toolsets).toEqual({ form: "datum-form/1", builder: "datum-builder/1" });
    expect(clean.findings).toEqual([]);
    const dirty = await cli("agent-tools", "--tools", dumpOf((tools) => tools.filter((tool) => tool["name"] !== "submit")), "--json");
    expect(dirty.code).toBe(1);
    expect((JSON.parse(dirty.out) as { findings: unknown[] }).findings).toEqual([{ kind: "missing-tool", catalogue: "form", tool: "submit" }]);
  });

  it("is not a capability: the command parses, the case catalogue has no agent case", () => {
    expect(parseHostArgs(["agent-tools", "--tools", "x.json"]).command).toBe("agent-tools");
    expect(CASES.some((entry) => /agent/i.test(entry.capability) || /agent/i.test(entry.id))).toBe(false);
  });

  it("is in the usage text", async () => {
    expect((await cli("--help")).out).toContain("agent-tools --tools <dump.json>");
  });
});
