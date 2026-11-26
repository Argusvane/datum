/**
 * Renders docs/reference/agent-tools.md, the catalogue of the agent tools.
 *
 * Everything an agent or a host reads off a tool comes from the code, so it cannot drift: the
 * title, the annotations, the description and the input schema are taken from the catalogues the
 * browser registers (`createFormAgentTools` over the agent form fixture, the session pair from
 * `session-tools.ts`, and the builder catalogue over the builder fixture, in
 * `BUILDER_AGENT_TOOL_NAMES` order). What the code cannot say is what a result looks like in
 * words and in a real call, and that is hand-written in `agent-tools-notes/`: the two section
 * lead-ins, one file per tool (its result type, failure modes and worked examples) and the two
 * sections' closing shared shapes. A tool without a notes file, or a notes file without a tool,
 * is an error: a new tool is not documented until its result is.
 *
 * `gen-agent-tools-reference.mjs` writes the file (or checks it with `--check`);
 * `tests/agent-tools-doc.test.ts` holds the committed file to this render.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFormAgentTools } from "../form-engine/agent/form/tools.js";
import { runtimeAgentHost } from "../form-engine/agent/form/host.js";
import { SESSION_TOOL_ANNOTATIONS, SESSION_TOOL_NAMES, SESSION_TOOL_TEXTS, sessionToolSchemas } from "../form-engine/agent/session-tools.js";
import type { AgentToolAnnotations } from "../form-engine/agent/tool-types.js";
import { AGENT_SINGLE_FORM, agentRuntime } from "../tests/fixtures/agent-form.js";
import { agentBuilder } from "../tests/fixtures/agent-builder.js";
// The tests' own setup registers the eager journey engine as the runtimes' default;
// the fixture runtimes lean on it, so a script has to register it too.
import "../tests/setup/journey-engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NOTES_DIR = join(HERE, "agent-tools-notes");
export const REFERENCE_PATH = resolve(HERE, "../../docs/reference/agent-tools.md");
/** The command that rewrites the file, for the header and for every failure message that names it. */
export const REWRITE_COMMAND = "npm run docs:agent-tools";
export const CHECK_COMMAND = "npm run docs:agent-tools:check";

interface CatalogueTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: Readonly<AgentToolAnnotations>;
}

/** The form half: the form catalogue over the fixture form, then the session pair. */
function formTools(): CatalogueTool[] {
  const catalogue = createFormAgentTools(runtimeAgentHost(agentRuntime(AGENT_SINGLE_FORM)));
  const schemas = sessionToolSchemas();
  return [
    ...catalogue.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? "",
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations
    })),
    ...SESSION_TOOL_NAMES.map((name) => ({ name, ...SESSION_TOOL_TEXTS[name], inputSchema: schemas[name], annotations: SESSION_TOOL_ANNOTATIONS }))
  ];
}

/** The builder half: the builder catalogue over the fixture builder, in registration order. */
function builderTools(): CatalogueTool[] {
  return agentBuilder().catalogue.tools.map((tool) => ({
    name: tool.name,
    title: tool.title ?? "",
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations
  }));
}

/**
 * The parenthesis after a tool's hints. The hints are what tells an agent and a host which calls
 * the browser confirms, so the parenthesis may not claim a hint or a confirmation the tool does
 * not carry: the session pair and `open` say why they carry no hint, every tool with a
 * `consequentialHint` (`submit`, `drafts`, `download_pdf`, `replace_form`, `save` ...) is one the
 * browser asks about, and any other tool with no hint is a write. Every other line has none.
 */
export function annotationNote(name: string, annotations: Readonly<AgentToolAnnotations>, hintCount: number): string | undefined {
  if (name === "begin_session" || name === "end_session") {
    return "page state only; nothing leaves the page, and Stop restores";
  }
  if (annotations.consequentialHint === true) {
    return "the browser asks the person to confirm";
  }
  if (name === "open") {
    return "it changes only what the person sees: not a history step, and it runs after Stop";
  }
  return hintCount === 0 ? "a write: shown, recorded and undoable" : undefined;
}

/** The Annotations line: the hints that are true, in backticks, or "none", then the note in parentheses. */
export function annotationsLine(tool: Pick<CatalogueTool, "name" | "annotations">): string {
  const hints = Object.entries(tool.annotations).filter(([, on]) => on === true).map(([hint]) => "`" + hint + "`");
  const note = annotationNote(tool.name, tool.annotations, hints.length);
  return "- Annotations: " + (hints.length > 0 ? hints.join(", ") : "none") + (note !== undefined ? " (" + note + ")" : "");
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A count in words, 0 to 99, for the section headings ("fourteen", "twenty-four"). */
function inWords(n: number): string {
  if (n < 20) {
    return SMALL[n] ?? String(n);
  }
  const tens = TENS[Math.floor(n / 10)] ?? String(n);
  return n % 10 === 0 ? tens : tens + "-" + SMALL[n % 10];
}

function note(file: string): string {
  const path = join(NOTES_DIR, file);
  if (!existsSync(path)) {
    throw new Error("No hand-written notes at " + path + ": add the file (the tool's result type, failure modes and worked examples) before the reference can be rendered.");
  }
  return readFileSync(path, "utf8").trim();
}

function toolSection(tool: CatalogueTool): string {
  if (tool.description.includes("\n")) {
    throw new Error(tool.name + ": the description holds a line break, which the reference's block quote cannot carry.");
  }
  return [
    "### `" + tool.name + "`",
    "",
    "- Title: " + tool.title,
    annotationsLine(tool),
    "- Description (exact):",
    "",
    "> " + tool.description,
    "",
    "Input schema:",
    "",
    "```json",
    JSON.stringify(tool.inputSchema, null, 2),
    "```",
    "",
    note("tools/" + tool.name + ".md")
  ].join("\n");
}

function half(heading: string, introFile: string, tailFile: string, tools: readonly CatalogueTool[]): string {
  return [heading, "", note(introFile), "", ...tools.flatMap((tool) => [toolSection(tool), ""]), note(tailFile)].join("\n");
}

/** The tools of both halves, in document order. */
export function referenceTools(): { form: CatalogueTool[]; builder: CatalogueTool[] } {
  return { form: formTools(), builder: builderTools() };
}

function checkNotesAreAllUsed(names: ReadonlySet<string>): void {
  const files = readdirSync(join(NOTES_DIR, "tools")).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3));
  const orphans = files.filter((file) => !names.has(file));
  if (orphans.length > 0) {
    throw new Error("Notes without a tool in " + join(NOTES_DIR, "tools") + ": " + orphans.join(", ") + ". Delete them or restore the tool.");
  }
}

/** The whole reference file, as it should be committed. */
export function renderAgentToolsReference(): string {
  const { form, builder } = referenceTools();
  checkNotesAreAllUsed(new Set([...form, ...builder].map((tool) => tool.name)));
  const header = [
    "# Agent tools reference",
    "",
    "<!-- Generated. Do not edit by hand. -->",
    "",
    "Generated by `engine/scripts/gen-agent-tools-reference.mjs` (`" + REWRITE_COMMAND + "` in `engine/`): each tool's title,",
    "annotations, description and input schema are read from the catalogues the browser registers, and the",
    "result types, failure modes and worked examples come from the notes in `engine/scripts/agent-tools-notes/`.",
    "Do not edit this file by hand: change the code or the notes and run the command again.",
    "`" + CHECK_COMMAND + "` fails when this file is stale. How the tools behave as a whole is in",
    "[Agent tools](../agent-tools.md)."
  ].join("\n");
  const formHalf = half("## The " + inWords(form.length) + " tools", "form-intro.md", "form-tail.md", form);
  const builderHalf = half("## The builder's " + inWords(builder.length) + " tools", "builder-intro.md", "builder-tail.md", builder);
  return [header, "", formHalf, "", builderHalf, ""].join("\n");
}

/** A short account of where two renders first differ: line counts, the nearest tool heading and the first lines apart. */
export function diffSummary(committed: string, fresh: string): string {
  if (committed === fresh) {
    return "identical";
  }
  const a = committed.split("\n");
  const b = fresh.split("\n");
  const limit = Math.max(a.length, b.length);
  const apart: number[] = [];
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) {
      apart.push(i);
    }
  }
  const first = apart[0] ?? 0;
  let tool = "the header";
  for (let i = Math.min(first, b.length - 1); i >= 0; i--) {
    const heading = /^##{1,2} (.*)$/.exec(b[i] ?? "");
    if (heading !== null) {
      tool = heading[1] ?? tool;
      break;
    }
  }
  const lines = [
    "committed " + a.length + " lines, fresh render " + b.length + " lines; " + apart.length + " line position(s) differ, the first at line " + (first + 1) + " under " + tool + ":"
  ];
  for (const index of apart.slice(0, 5)) {
    lines.push("  line " + (index + 1) + " committed: " + JSON.stringify((a[index] ?? "<end of file>").slice(0, 160)));
    lines.push("  line " + (index + 1) + " fresh:     " + JSON.stringify((b[index] ?? "<end of file>").slice(0, 160)));
  }
  return lines.join("\n");
}
