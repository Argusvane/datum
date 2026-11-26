// Regenerates golden/agent-tools.json from the engine's own catalogues: the twelve
// renderer tools, the session pair and the builder's twenty-four, with the strings a browser holds
// (name, title, description, input schema, annotations and the few flags that change how the
// registrar treats a tool). The vitest check (tests/agent-tools-catalogue.test.ts) compares the live
// catalogues and docs/reference/agent-tools.md to this file, and `datum-host-check agent-tools` compares a
// page's own dump to it, so a reworded description is a failure until this script is run on purpose
// and the diff reviewed.
//   npm run golden:agent
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_TOOLSET_VERSION,
  BUILDER_AGENT_TOOL_NAMES,
  createBuilderTools,
  createFormAgentTools,
  FORM_AGENT_TOOL_NAMES,
  runtimeAgentHost,
  SESSION_TOOL_ANNOTATIONS,
  SESSION_TOOL_NAMES,
  SESSION_TOOL_TEXTS,
  sessionToolSchemas,
  type AgentTool
} from "@argusvane/datum-engine/agent";
import { AGENT_SINGLE_FORM, agentRuntime } from "@argusvane/datum-engine/tests/fixtures/agent-form";
import { agentBuilder } from "@argusvane/datum-engine/tests/fixtures/agent-builder";

/** Object keys sorted at every depth (arrays keep their order), so a regeneration diff shows only what moved. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }
  return value;
}

type Row = Record<string, unknown>;

function row(tool: Pick<AgentTool, "name" | "title" | "description" | "inputSchema" | "annotations"> & Partial<Pick<AgentTool, "allowedWhileStopped" | "readActions" | "answersWhenOff" | "inputBytes">>): Row {
  const out: Row = { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
  if (tool.allowedWhileStopped !== undefined) out["allowedWhileStopped"] = tool.allowedWhileStopped;
  if (tool.readActions !== undefined) out["readActions"] = { key: tool.readActions.key, values: [...tool.readActions.values] };
  if (tool.answersWhenOff !== undefined) out["answersWhenOff"] = tool.answersWhenOff;
  if (tool.inputBytes !== undefined) out["inputBytes"] = tool.inputBytes;
  return out;
}

function inOrder(label: string, rows: Row[], names: readonly string[]): Row[] {
  const got = rows.map((entry) => entry["name"]).join();
  if (got !== names.join()) throw new Error(`golden: the ${label} catalogue's order differs from its name list\n  catalogue: ${got}\n  names:     ${names.join()}`);
  return rows;
}

const formTools = inOrder("form", createFormAgentTools(runtimeAgentHost(agentRuntime(AGENT_SINGLE_FORM))).tools.map((tool) => row(tool)), FORM_AGENT_TOOL_NAMES);
const schemas = sessionToolSchemas();
// The registrar keeps the session pair's flags in a private spec (sessionWrappers: allowedWhileStopped for
// end_session only, so an assistant can close its session after Stop), not on the tools it exposes, so the
// flag is stated here and in the vitest check; changing the registrar's rule means changing both on purpose.
const sessionTools = SESSION_TOOL_NAMES.map((name) =>
  row({ name, title: SESSION_TOOL_TEXTS[name].title, description: SESSION_TOOL_TEXTS[name].description, inputSchema: schemas[name], annotations: SESSION_TOOL_ANNOTATIONS, ...(name === "end_session" ? { allowedWhileStopped: true } : {}) })
);
const builderTools = inOrder("builder", agentBuilder({ id: "contact-request" }).catalogue.tools.map((tool) => row(tool)), BUILDER_AGENT_TOOL_NAMES);

const golden = { kind: "datum-agent-tools", version: 1, toolsets: { form: AGENT_TOOLSET_VERSION.form, builder: AGENT_TOOLSET_VERSION.builder }, form: formTools, session: sessionTools, builder: builderTools };

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "golden", "agent-tools.json");
writeFileSync(target, `${JSON.stringify(sortKeys(golden), null, 2)}\n`);
console.log(`golden: wrote ${target} (${formTools.length} form, ${sessionTools.length} session, ${builderTools.length} builder tools)`);
