// The agent tools catalogue check: three pure comparisons against
// golden/agent-tools.json, which `npm run golden:agent` writes from the engine's own catalogues.
// Nothing here imports the engine or touches a DOM, so the host-check bundle stays small and a
// page's dump can be judged on a machine that has only the shipped golden.

/** The shape of golden/agent-tools.json (and of the live catalogues the test builds, so one comparer reads both). */
export interface AgentToolsGolden {
  kind: "datum-agent-tools";
  version: 1;
  toolsets: { form: string; builder: string };
  form: GoldenTool[];
  session: GoldenTool[];
  builder: GoldenTool[];
}

export interface GoldenTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: Record<string, unknown>;
  allowedWhileStopped?: boolean;
  readActions?: { key: string; values: string[] };
  answersWhenOff?: true;
  inputBytes?: number;
}

export type AgentToolsFindingKind = "missing-tool" | "extra-tool" | "order" | "title" | "description" | "input-schema" | "annotations" | "flag" | "toolset" | "doc-section";

export interface AgentToolsFinding {
  kind: AgentToolsFindingKind;
  catalogue: "form" | "session" | "builder";
  tool?: string;
  field?: string;
  expected?: unknown;
  got?: unknown;
}

type Catalogue = AgentToolsFinding["catalogue"];
const CATALOGUES: readonly Catalogue[] = ["form", "session", "builder"];
/** The flags a dump cannot carry (a page's getTools() shows strings and annotations only), compared catalogue to golden. */
const FLAGS = ["allowedWhileStopped", "readActions", "answersWhenOff", "inputBytes"] as const;

/** Keys sorted at every depth, so two schemas that differ only in key order are equal. */
function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sorted(entry)])
    );
  }
  return value;
}

function differs(a: unknown, b: unknown): boolean {
  return canonical(a) !== canonical(b);
}

/** Live catalogues (the same shape as the golden) against the golden: every difference, in catalogue order. */
export function compareAgentCatalogues(golden: AgentToolsGolden, live: AgentToolsGolden): AgentToolsFinding[] {
  const findings: AgentToolsFinding[] = [];
  for (const catalogue of ["form", "builder"] as const) {
    if (golden.toolsets[catalogue] !== live.toolsets[catalogue]) {
      findings.push({ kind: "toolset", catalogue, field: "toolsets", expected: golden.toolsets[catalogue], got: live.toolsets[catalogue] });
    }
  }
  for (const catalogue of CATALOGUES) {
    const want = golden[catalogue];
    const have = live[catalogue];
    const liveByName = new Map(have.map((tool) => [tool.name, tool]));
    const goldenNames = new Set(want.map((tool) => tool.name));
    for (const tool of want) {
      if (!liveByName.has(tool.name)) findings.push({ kind: "missing-tool", catalogue, tool: tool.name });
    }
    for (const tool of have) {
      if (!goldenNames.has(tool.name)) findings.push({ kind: "extra-tool", catalogue, tool: tool.name });
    }
    const wantOrder = want.filter((tool) => liveByName.has(tool.name)).map((tool) => tool.name);
    const haveOrder = have.filter((tool) => goldenNames.has(tool.name)).map((tool) => tool.name);
    if (wantOrder.join() !== haveOrder.join()) findings.push({ kind: "order", catalogue, expected: wantOrder, got: haveOrder });
    for (const tool of want) {
      const found = liveByName.get(tool.name);
      if (found === undefined) continue;
      if (tool.title !== found.title) findings.push({ kind: "title", catalogue, tool: tool.name, expected: tool.title, got: found.title });
      if (tool.description !== found.description) findings.push({ kind: "description", catalogue, tool: tool.name, expected: tool.description, got: found.description });
      if (differs(tool.inputSchema, found.inputSchema)) findings.push({ kind: "input-schema", catalogue, tool: tool.name, expected: sorted(tool.inputSchema), got: sorted(found.inputSchema) });
      if (differs(tool.annotations, found.annotations)) findings.push({ kind: "annotations", catalogue, tool: tool.name, expected: sorted(tool.annotations), got: sorted(found.annotations) });
      for (const flag of FLAGS) {
        if (differs(tool[flag], found[flag])) findings.push({ kind: "flag", catalogue, tool: tool.name, field: flag, expected: tool[flag], got: found[flag] });
      }
    }
  }
  return findings;
}

/** The text of the page between a tool's "### `name`" heading and the next level-3 heading, or undefined. */
function sectionOf(markdown: string, name: string): string | undefined {
  const start = markdown.indexOf(`\n### \`${name}\`\n`);
  if (start < 0) return undefined;
  const next = markdown.indexOf("\n### ", start + 1);
  return markdown.slice(start, next < 0 ? undefined : next);
}

/**
 * docs/reference/agent-tools.md (the generated tool reference) against the golden, by the rules of engine/tests/agent-tools-doc.test.ts: a
 * "### `name`" section per tool holding "- Title: <title>", "> <description>" on its own line and
 * the schema in a json fence (compared as JSON, so the golden's sorted keys match the page's order). A section the golden does not
 * name is a finding too (a documented tool that no catalogue has).
 */
export function compareAgentDocs(golden: AgentToolsGolden, markdown: string): AgentToolsFinding[] {
  const findings: AgentToolsFinding[] = [];
  const known = new Set<string>();
  for (const catalogue of CATALOGUES) {
    for (const tool of golden[catalogue]) {
      known.add(tool.name);
      const section = sectionOf(markdown, tool.name);
      if (section === undefined) {
        findings.push({ kind: "doc-section", catalogue, tool: tool.name, field: "section", expected: `### \`${tool.name}\`` });
        continue;
      }
      if (!section.includes(`- Title: ${tool.title}\n`)) findings.push({ kind: "doc-section", catalogue, tool: tool.name, field: "title", expected: tool.title });
      if (!section.includes(`\n> ${tool.description}\n`)) findings.push({ kind: "doc-section", catalogue, tool: tool.name, field: "description", expected: tool.description });
      // The golden's keys are sorted and the page keeps the catalogue's own order, so the fence is read as JSON.
      const fence = /```json\n([\s\S]*?)\n```/.exec(section);
      if (fence === null || differs(tool.inputSchema, schemaOf(fence[1]))) findings.push({ kind: "doc-section", catalogue, tool: tool.name, field: "input-schema", expected: sorted(tool.inputSchema) });
    }
  }
  for (const match of markdown.matchAll(/\n### `([a-z_]+)`\n/g)) {
    const name = match[1] as string;
    if (!known.has(name)) findings.push({ kind: "doc-section", catalogue: "form", tool: name, field: "extra-section", got: name });
  }
  return findings;
}

interface DumpedTool {
  name: string;
  title: unknown;
  description: unknown;
  inputSchema: unknown;
  annotations: unknown;
}

/** A tool dump may carry the schema as a JSON string (a browser's getTools() does) or as an object (agentTools() does). */
function schemaOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * A page's dump (getTools() or agentTools() output: name, title, description, inputSchema,
 * annotations?) against the golden: names in a whole catalogue, description and schema equal, title
 * equal when the dump's is not empty, annotations equal on the keys both carry. A dump holding
 * `describe_form` must hold all the form tools and the session pair, one holding `describe_builder`
 * all the builder tools and the pair; any other name is an extra tool.
 */
export function compareToolDump(golden: AgentToolsGolden, dump: readonly unknown[]): AgentToolsFinding[] {
  const findings: AgentToolsFinding[] = [];
  const byName = new Map<string, DumpedTool>();
  for (const entry of dump) {
    const name = entry !== null && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string") {
      findings.push({ kind: "extra-tool", catalogue: "form", field: "name", got: entry });
      continue;
    }
    byName.set(name, entry as DumpedTool);
  }
  const hasForm = byName.has("describe_form");
  const hasBuilder = byName.has("describe_builder");
  const expected: { catalogue: Catalogue; tools: GoldenTool[] }[] = [];
  if (hasForm) expected.push({ catalogue: "form", tools: golden.form });
  if (hasBuilder) expected.push({ catalogue: "builder", tools: golden.builder });
  if (hasForm || hasBuilder) expected.push({ catalogue: "session", tools: golden.session });
  if (!hasForm && !hasBuilder) {
    // Neither entry point: report the two a datum page cannot lack, then hold the rest to "extra".
    findings.push({ kind: "missing-tool", catalogue: "form", tool: "describe_form" }, { kind: "missing-tool", catalogue: "builder", tool: "describe_builder" });
  }
  const claimed = new Set<string>();
  for (const { catalogue, tools } of expected) {
    for (const tool of tools) {
      claimed.add(tool.name);
      const found = byName.get(tool.name);
      if (found === undefined) {
        findings.push({ kind: "missing-tool", catalogue, tool: tool.name });
        continue;
      }
      if (typeof found.title === "string" && found.title !== "" && found.title !== tool.title) findings.push({ kind: "title", catalogue, tool: tool.name, expected: tool.title, got: found.title });
      if (found.description !== tool.description) findings.push({ kind: "description", catalogue, tool: tool.name, expected: tool.description, got: found.description });
      if (differs(tool.inputSchema, schemaOf(found.inputSchema))) findings.push({ kind: "input-schema", catalogue, tool: tool.name, expected: sorted(tool.inputSchema), got: sorted(schemaOf(found.inputSchema)) });
      const carried = found.annotations !== null && typeof found.annotations === "object" ? (found.annotations as Record<string, unknown>) : undefined;
      if (carried !== undefined) {
        const shared = Object.keys(carried).filter((key) => key in tool.annotations);
        const wantShared = Object.fromEntries(shared.map((key) => [key, tool.annotations[key]]));
        const gotShared = Object.fromEntries(shared.map((key) => [key, carried[key]]));
        if (differs(wantShared, gotShared)) findings.push({ kind: "annotations", catalogue, tool: tool.name, expected: sorted(wantShared), got: sorted(gotShared) });
      }
    }
  }
  for (const name of byName.keys()) {
    if (!claimed.has(name)) findings.push({ kind: "extra-tool", catalogue: hasBuilder && !hasForm ? "builder" : "form", tool: name });
  }
  return findings;
}
