import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_TOOLSET_VERSION,
  BUILDER_AGENT_TOOL_NAMES,
  createFormAgentTools,
  FORM_AGENT_TOOL_NAMES,
  runtimeAgentHost,
  SESSION_TOOL_ANNOTATIONS,
  SESSION_TOOL_NAMES,
  SESSION_TOOL_TEXTS,
  sessionToolSchemas,
  type AgentTool
} from "@argusvane/datum-engine/agent";
import { agentBuilder } from "@argusvane/datum-engine/tests/fixtures/agent-builder";
import { AGENT_SINGLE_FORM, agentRuntime } from "@argusvane/datum-engine/tests/fixtures/agent-form";

import { compareAgentCatalogues, compareAgentDocs, compareToolDump, type AgentToolsGolden, type GoldenTool } from "../src/host-check/agent-tools/compare.js";
import { PACKAGE_ROOT, REPO_ROOT } from "./helpers/paths.js";

/**
 * The agent tools catalogue check: the engine's live catalogues and
 * docs/reference/agent-tools.md against golden/agent-tools.json. A reworded description, a new schema property or
 * a changed hint fails here until `npm run golden:agent` is run on purpose, the diff reviewed and the
 * doc regenerated.
 */
const golden = JSON.parse(readFileSync(join(PACKAGE_ROOT, "golden", "agent-tools.json"), "utf8")) as AgentToolsGolden;

function rowOf(tool: Pick<AgentTool, "name" | "title" | "description" | "inputSchema" | "annotations"> & Partial<Pick<AgentTool, "allowedWhileStopped" | "readActions" | "answersWhenOff" | "inputBytes">>): GoldenTool {
  const out: GoldenTool = { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { ...tool.annotations } };
  if (tool.allowedWhileStopped !== undefined) out.allowedWhileStopped = tool.allowedWhileStopped;
  if (tool.readActions !== undefined) out.readActions = { key: tool.readActions.key, values: [...tool.readActions.values] };
  if (tool.answersWhenOff !== undefined) out.answersWhenOff = tool.answersWhenOff;
  if (tool.inputBytes !== undefined) out.inputBytes = tool.inputBytes;
  return out;
}

/** The live catalogues in the golden's shape, built as scripts/write-agent-golden.ts builds them. */
function liveCatalogues(): AgentToolsGolden {
  const schemas = sessionToolSchemas();
  return {
    kind: "datum-agent-tools",
    version: 1,
    toolsets: { form: AGENT_TOOLSET_VERSION.form, builder: AGENT_TOOLSET_VERSION.builder },
    form: createFormAgentTools(runtimeAgentHost(agentRuntime(AGENT_SINGLE_FORM))).tools.map(rowOf),
    // end_session alone is allowed while stopped (registrar sessionWrappers keeps that in a private spec); stated as the script states it.
    session: SESSION_TOOL_NAMES.map((name) =>
      rowOf({ name, title: SESSION_TOOL_TEXTS[name].title, description: SESSION_TOOL_TEXTS[name].description, inputSchema: schemas[name], annotations: SESSION_TOOL_ANNOTATIONS, ...(name === "end_session" ? { allowedWhileStopped: true } : {}) })
    ),
    builder: agentBuilder({ id: "contact-request" }).catalogue.tools.map(rowOf)
  };
}

/** A deep copy the test may change. */
function copyOf(value: AgentToolsGolden): AgentToolsGolden {
  return JSON.parse(JSON.stringify(value)) as AgentToolsGolden;
}

function toolOf(file: AgentToolsGolden, name: string): GoldenTool {
  const found = [...file.form, ...file.session, ...file.builder].find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("golden/agent-tools.json", () => {
  it("holds twelve renderer tools, the session pair and twenty-four builder tools, in the catalogues' order", () => {
    expect(golden.kind).toBe("datum-agent-tools");
    expect(golden.version).toBe(1);
    expect(golden.form).toHaveLength(12);
    expect(golden.session).toHaveLength(2);
    expect(golden.builder).toHaveLength(24);
    expect(golden.form.map((tool) => tool.name)).toEqual([...FORM_AGENT_TOOL_NAMES]);
    expect(golden.session.map((tool) => tool.name)).toEqual([...SESSION_TOOL_NAMES]);
    expect(golden.builder.map((tool) => tool.name)).toEqual([...BUILDER_AGENT_TOOL_NAMES]);
  });

  it("names the two toolsets", () => {
    expect(golden.toolsets).toEqual({ form: "datum-form/1", builder: "datum-builder/1" });
  });

  it("is the file the script writes: keys sorted, two-space JSON, a trailing newline", () => {
    const text = readFileSync(join(PACKAGE_ROOT, "golden", "agent-tools.json"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const sort = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sort)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, sort(entry)])
            )
          : value;
    expect(text).toBe(`${JSON.stringify(sort(golden), null, 2)}\n`);
  });

  it("records the flags that change how the registrar treats a tool, and only when set", () => {
    expect(toolOf(golden, "describe_form").answersWhenOff).toBe(true);
    expect(toolOf(golden, "undo_agent_changes").allowedWhileStopped).toBe(true);
    expect(toolOf(golden, "end_session").allowedWhileStopped).toBe(true);
    expect("allowedWhileStopped" in toolOf(golden, "begin_session")).toBe(false);
    expect(toolOf(golden, "add_components").inputBytes).toBe(512 * 1024);
    expect(toolOf(golden, "documents").readActions).toBeDefined();
    expect("answersWhenOff" in toolOf(golden, "get_answers")).toBe(false);
  });
});

describe("the live catalogues against the golden", () => {
  it("are the golden, field for field (a change is a failure until the golden is regenerated)", () => {
    expect(compareAgentCatalogues(golden, liveCatalogues())).toEqual([]);
  });

  it("differ by exactly one description finding when one description changed", () => {
    const changed = copyOf(golden);
    toolOf(changed, "get_answers").description += " (reworded)";
    const findings = compareAgentCatalogues(changed, liveCatalogues());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "description", catalogue: "form", tool: "get_answers" });
  });

  it("report a missing tool, an extra one, a moved one, a schema, a hint, a flag and a toolset", () => {
    const live = liveCatalogues();
    const want = copyOf(golden);
    want.form.push({ name: "invented", title: "x", description: "x", inputSchema: { type: "object" }, annotations: {} });
    expect(compareAgentCatalogues(want, live)).toEqual([{ kind: "missing-tool", catalogue: "form", tool: "invented" }]);
    expect(compareAgentCatalogues(live, want)).toEqual([{ kind: "extra-tool", catalogue: "form", tool: "invented" }]);

    const moved = copyOf(golden);
    moved.builder.reverse();
    expect(compareAgentCatalogues(moved, live).map((finding) => finding.kind)).toEqual(["order"]);

    const schema = copyOf(golden);
    (toolOf(schema, "set_answers").inputSchema as { properties: Record<string, unknown> }).properties["extra"] = { type: "string", description: "x" };
    expect(compareAgentCatalogues(schema, live)).toMatchObject([{ kind: "input-schema", tool: "set_answers" }]);

    const hint = copyOf(golden);
    toolOf(hint, "describe_form").annotations["readOnlyHint"] = false;
    expect(compareAgentCatalogues(hint, live)).toMatchObject([{ kind: "annotations", tool: "describe_form" }]);

    const flag = copyOf(golden);
    delete toolOf(flag, "describe_form").answersWhenOff;
    expect(compareAgentCatalogues(flag, live)).toMatchObject([{ kind: "flag", tool: "describe_form", field: "answersWhenOff" }]);

    // Each flag is read on its own: a flag dropped from the golden, or changed in it, is one finding naming it.
    for (const [tool, field] of [
      ["add_components", "inputBytes"],
      ["documents", "readActions"],
      ["undo_agent_changes", "allowedWhileStopped"],
      ["end_session", "allowedWhileStopped"]
    ] as const) {
      const dropped = copyOf(golden);
      delete toolOf(dropped, tool)[field];
      expect(compareAgentCatalogues(dropped, live)).toMatchObject([{ kind: "flag", tool, field }]);
    }
    const bytes = copyOf(golden);
    toolOf(bytes, "add_components").inputBytes = 1;
    expect(compareAgentCatalogues(bytes, live)).toMatchObject([{ kind: "flag", tool: "add_components", field: "inputBytes", expected: 1 }]);

    const toolset = copyOf(golden);
    toolset.toolsets.builder = "datum-builder/2";
    expect(compareAgentCatalogues(toolset, live)).toMatchObject([{ kind: "toolset", catalogue: "builder" }]);
  });

  it("reads schemas as canonical JSON: key order alone is no difference", () => {
    const reordered = copyOf(golden);
    const tool = toolOf(reordered, "set_answers");
    tool.inputSchema = Object.fromEntries(Object.entries(tool.inputSchema as Record<string, unknown>).reverse());
    expect(compareAgentCatalogues(golden, reordered)).toEqual([]);
  });
});

describe("docs/reference/agent-tools.md against the golden", () => {
  const markdown = readFileSync(join(REPO_ROOT, "docs", "reference", "agent-tools.md"), "utf8");

  it("quotes every tool's title, description and schema (a section per tool)", () => {
    expect(compareAgentDocs(golden, markdown)).toEqual([]);
  });

  it("finds a missing section, a changed description and a documented tool the catalogues do not have", () => {
    expect(compareAgentDocs(golden, markdown.replace("\n### `describe_form`\n", "\n### `describe_forms`\n"))).toEqual(
      expect.arrayContaining([
        { kind: "doc-section", catalogue: "form", tool: "describe_form", field: "section", expected: "### `describe_form`" },
        { kind: "doc-section", catalogue: "form", tool: "describe_forms", field: "extra-section", got: "describe_forms" }
      ])
    );
    const title = toolOf(golden, "get_answers").title;
    const retitled = compareAgentDocs(golden, markdown.replace(`- Title: ${title}\n`, "- Title: Something else\n"));
    expect(retitled.filter((finding) => finding.tool === "get_answers")).toMatchObject([{ kind: "doc-section", field: "title", expected: title }]);
    // The first json fence of a section is the input schema: breaking it (here, a property renamed) is a finding.
    const start = markdown.indexOf("\n### `get_answers`\n");
    const fenceAt = markdown.indexOf("```json\n", start);
    const broken = `${markdown.slice(0, fenceAt)}\`\`\`json\n{ "type": "string" }\n\`\`\`${markdown.slice(markdown.indexOf("\n```", fenceAt + 8) + 4)}`;
    expect(compareAgentDocs(golden, broken).filter((finding) => finding.tool === "get_answers")).toMatchObject([{ kind: "doc-section", field: "input-schema" }]);
    const description = toolOf(golden, "get_answers").description;
    const reworded = compareAgentDocs(golden, markdown.replace(`\n> ${description}\n`, "\n> something else\n"));
    expect(reworded.filter((finding) => finding.tool === "get_answers")).toMatchObject([{ kind: "doc-section", field: "description" }]);
  });
});

describe("a page's tool dump against the golden", () => {
  const asDump = (tools: GoldenTool[]) => tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }));
  const formPage = [...golden.form, ...golden.session];
  const builderPage = [...golden.builder, ...golden.session];

  it("is empty for the golden's own rows, on a form page, a builder page and a page with both", () => {
    expect(compareToolDump(golden, asDump(formPage))).toEqual([]);
    expect(compareToolDump(golden, asDump(builderPage))).toEqual([]);
    expect(compareToolDump(golden, asDump([...golden.form, ...golden.builder, ...golden.session]))).toEqual([]);
  });

  it("reads a schema given as JSON text (a browser's getTools()) and a title left empty", () => {
    const dump = asDump(formPage).map((tool) => ({ ...tool, inputSchema: JSON.stringify(tool.inputSchema), title: "" }));
    expect(compareToolDump(golden, dump)).toEqual([]);
  });

  it("reports a dump missing submit", () => {
    const dump = asDump(formPage).filter((tool) => tool.name !== "submit");
    expect(compareToolDump(golden, dump)).toEqual([{ kind: "missing-tool", catalogue: "form", tool: "submit" }]);
  });

  it("reports a form page missing the session pair, and a name no catalogue has", () => {
    const dump = [...asDump(golden.form), { name: "fill_everything", description: "x", inputSchema: { type: "object" } }];
    const kinds = compareToolDump(golden, dump).map((finding) => `${finding.kind}:${finding.tool}`);
    expect(kinds).toEqual(["missing-tool:begin_session", "missing-tool:end_session", "extra-tool:fill_everything"]);
  });

  it("reports a changed description, schema, title and hint, and ignores a hint the golden does not carry", () => {
    const dump = asDump(formPage).map((tool) => {
      if (tool.name === "describe_form") return { ...tool, description: `${tool.description}!` };
      if (tool.name === "get_answers") return { ...tool, inputSchema: { type: "object", properties: {} } };
      if (tool.name === "set_answers") return { ...tool, title: "Fill" };
      if (tool.name === "submit") return { ...tool, annotations: { ...tool.annotations, vendorHint: true } };
      if (tool.name === "check") return { ...tool, annotations: { ...tool.annotations, readOnlyHint: false } };
      return tool;
    });
    expect(compareToolDump(golden, dump).map((finding) => `${finding.kind}:${finding.tool}`)).toEqual(["description:describe_form", "input-schema:get_answers", "annotations:check", "title:set_answers"]);
  });

  it("holds a dump with neither entry point to account", () => {
    expect(compareToolDump(golden, [])).toEqual([
      { kind: "missing-tool", catalogue: "form", tool: "describe_form" },
      { kind: "missing-tool", catalogue: "builder", tool: "describe_builder" }
    ]);
    expect(compareToolDump(golden, [{ name: "other" }]).map((finding) => finding.kind)).toEqual(["missing-tool", "missing-tool", "extra-tool"]);
    expect(compareToolDump(golden, ["x", 4]).filter((finding) => finding.kind === "extra-tool")).toHaveLength(2);
  });
});
