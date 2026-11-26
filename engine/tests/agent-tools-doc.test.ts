import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDER_AGENT_TOOL_NAMES } from "../form-engine/agent/builder/tools.js";
import { CHECK_COMMAND, REFERENCE_PATH, REWRITE_COMMAND, diffSummary, referenceTools, renderAgentToolsReference } from "../scripts/agent-tools-reference.js";
import { agentBuilder, okOf, uiStub } from "./fixtures/agent-builder.js";

/**
 * The agent tools' documentation is two files.
 *
 * docs/reference/agent-tools.md is generated: every tool's title, annotations, description and
 * input schema are read from the catalogues the browser registers (the renderer's twelve, the
 * session pair and the builder's twenty-four, over the fixtures), beside the hand-written result
 * notes in engine/scripts/agent-tools-notes. A reworded description, a new schema property, a
 * changed annotation or a new tool changes the render, and this holds the committed file to it.
 *
 * docs/agent-tools.md is the guide: how the tools work as a whole. It carries no schemas, so
 * it cannot go stale that way; what it must do is name every tool, so one added to a catalogue
 * is not left out of the guide.
 */
const guide = readFileSync(resolve(__dirname, "../../docs/agent-tools.md"), "utf8");
const reference = readFileSync(REFERENCE_PATH, "utf8");
const flatGuide = guide.replace(/\s+/g, " ");
const flatReference = reference.replace(/\s+/g, " ");

/** The text of a level-2 section of the guide, from its heading to the next one. */
function guideSection(heading: string): string {
  const start = guide.indexOf("\n## " + heading + "\n");
  expect(start, "the guide has a section '" + heading + "'").toBeGreaterThan(0);
  const next = guide.indexOf("\n## ", start + 1);
  return guide.slice(start, next < 0 ? undefined : next);
}

/** The tool names a section's summary lines open with: "- `name`: what it does". */
function summaryNames(section: string): string[] {
  return [...section.matchAll(/^- `([a-z_]+)`: /gm)].map((match) => match[1] as string);
}

/** The text of the reference between `### \`name\`` and the next level-3 heading. */
function referenceSection(name: string): string {
  const start = reference.indexOf("\n### `" + name + "`\n");
  expect(start, "the reference has a section for " + name).toBeGreaterThan(0);
  const next = reference.indexOf("\n### ", start + 1);
  return reference.slice(start, next < 0 ? undefined : next);
}

describe("docs/reference/agent-tools.md", () => {
  it("is what the generator renders from the catalogues now", () => {
    const fresh = renderAgentToolsReference();
    // The message names the command, so a failing run says how to fix it.
    expect(reference === fresh, "docs/reference/agent-tools.md is stale; run `" + REWRITE_COMMAND + "` in engine/ and commit the result (`" + CHECK_COMMAND + "` shows the difference).\n" + diffSummary(reference, fresh)).toBe(true);
  });

  it("has a section for each of the thirty-eight tools, the builder's in BUILDER_AGENT_TOOL_NAMES order", () => {
    const { form, builder } = referenceTools();
    expect(form).toHaveLength(14);
    expect(builder.map((tool) => tool.name)).toEqual([...BUILDER_AGENT_TOOL_NAMES]);
    const half = reference.indexOf("\n## The builder's ");
    expect(half).toBeGreaterThan(0);
    const names = (text: string) => [...text.matchAll(/\n### `([a-z_]+)`\n/g)].map((match) => match[1]);
    expect(names(reference.slice(0, half))).toEqual(form.map((tool) => tool.name));
    expect(names(reference.slice(half))).toEqual(builder.map((tool) => tool.name));
  });

  it("claims a confirmation only for the tools whose annotations ask for one", () => {
    // The hints are what tells an agent and a host which calls the browser confirms, so the
    // note beside them may not promise a confirmation a tool does not carry, or leave one out.
    const { form, builder } = referenceTools();
    const wrong: string[] = [];
    for (const tool of [...form, ...builder]) {
      const line = referenceSection(tool.name).split("\n").find((entry) => entry.startsWith("- Annotations: ")) ?? "";
      const claims = line.includes("the browser asks the person to confirm");
      if (claims !== (tool.annotations.consequentialHint === true) || line.includes("`consequentialHint`") !== claims) {
        wrong.push(tool.name);
      }
      for (const [hint, on] of Object.entries(tool.annotations)) {
        if (line.includes("`" + hint + "`") !== (on === true)) {
          wrong.push(tool.name + ": " + hint);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("says a builder's begin_session result has locked: true and no pausedTyping, as the builder answers", async () => {
    // The form's BeginSessionResult declares pausedTyping as required; the builder never sends
    // it, so "the same shape" alone would promise a boolean an agent reads back as undefined.
    const begun = okOf(await agentBuilder({ ui: uiStub() }).execute("begin_session", { purpose: "Doc check" }));
    expect(begun.locked).toBe(true);
    expect("pausedTyping" in begun).toBe(false);
    expect(flatReference).toContain("On a builder page the result has the same shape with `locked: true` and no `pausedTyping`;");
    expect(flatReference).toContain("`begin_session` answers the shape shown for a form with `locked: true` and no `pausedTyping`;");
  });

  it("lists every warning code the builder writes for fromData and keep", () => {
    expect(flatReference).toContain("`ignored-keep:`");
  });
});

describe("docs/agent-tools.md", () => {
  const { form, builder } = referenceTools();

  it("names every form tool, and every builder tool, once in its summary lines", () => {
    // A tool added to a catalogue is missing here until the guide says what it is for.
    expect(summaryNames(guideSection("The form's tools"))).toEqual(form.map((tool) => tool.name));
    expect(summaryNames(guideSection("The builder's tools"))).toEqual(builder.map((tool) => tool.name));
  });

  it("points at the generated reference for the catalogue and carries none of it", () => {
    expect(guide).toContain("(reference/agent-tools.md)");
    expect(guide).not.toMatch(/\n### `[a-z_]+`\n/);
    expect(guide).not.toContain("Input schema:");
  });

  it("names the builder's body chunks, so a host deploys all five", () => {
    // dist/feature-files.json lists five files under agent; a host that deploys only the two
    // entry-named chunks makes try_it, languages and documents answer chunk-unavailable.
    expect(flatGuide).toContain("`datum-builder-agentpart-{try,languages,documents}-<hash>.js`");
    expect(flatGuide).toContain("lists all five under `agent`");
  });

  it("the Testing recipe waits for the first datum-agent-tools, whatever its outcome, and fails with its reason", () => {
    const testing = guide.slice(guide.indexOf("\n## Testing your page\n"));
    // A listener that waited for registered: true only would hang on a refused page instead of
    // failing with the reason.
    expect(testing).toContain('document.addEventListener("datum-agent-tools", (event) => resolve(event.detail), { once: true });');
    expect(testing).toContain("if (!detail.registered) throw new Error(detail.reason);");
    expect(testing).not.toContain("if (event.detail.registered)");
  });

  it("states the host's and the author's switches in the maintainer's terms", () => {
    // The host enforces (always, which bypasses the author's off), the definition decides (the default), the host forbids (never).
    expect(flatGuide).toContain("the host enforces");
    expect(flatGuide).toContain("the definition decides");
    expect(flatGuide).toContain("the host forbids");
    expect(flatGuide).toContain("A host's `always` overrides the author's `off`");
    expect(flatGuide).toContain("A host that writes the token without `agent-access` gets the default, `definition`.");
    expect(guide).toMatch(/^\| `agent-off` \|/m);
    // Nothing in either page describes the author layer, the studio control or the conformance entry as unbuilt.
    for (const text of [flatGuide, flatReference]) {
      expect(text).not.toMatch(/not built/i);
      expect(text).not.toContain("The definition has no flag for it");
    }
  });
});
