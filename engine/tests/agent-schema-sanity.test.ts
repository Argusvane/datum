import { describe, expect, it } from "vitest";

import { createFormAgentTools, FORM_AGENT_TOOL_NAMES } from "../form-engine/agent/form/tools.js";
import { runtimeAgentHost } from "../form-engine/agent/form/host.js";
import { SESSION_TOOL_ANNOTATIONS, SESSION_TOOL_NAMES, SESSION_TOOL_TEXTS, sessionToolSchemas } from "../form-engine/agent/session-tools.js";
import type { AgentTool } from "../form-engine/agent/tool-types.js";
import { AGENT_JOURNEY_FORM, agentRuntime } from "./fixtures/agent-form.js";
import { BUILDER_AGENT_TOOL_NAMES, createBuilderTools } from "../form-engine/agent/builder/tools.js";
import { createControllerHost } from "../form-engine/agent/builder/host.js";
import { contactRequestController } from "./fixtures/agent-builder.js";

/**
 * The schema-sanity test over the renderer catalogue and the session pair:
 * what Chrome stores verbatim and a model reads must fit the closed keyword subset, carry a
 * description on every property and round-trip through JSON. It covers the builder catalogue
 * in the same file, the folded-action
 * convention over every folded tool of either catalogue, the description caps (1,300
 * characters for a folded tool, 800 for every other) in both blocks,
 * and writes the page check without a literal count.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;

/** The folded tools; `remove_part`'s `kind` plays the action's role. */
const FOLDED_TOOLS: Readonly<Record<string, string>> = { try_it: "action", languages: "action", documents: "action", remove_part: "kind", drafts: "action" };

/** A folded tool's description lists every action, so it may run to 1,300; every other tool's to 800. */
function descriptionCap(name: string): number {
  return Object.prototype.hasOwnProperty.call(FOLDED_TOOLS, name) ? 1_300 : 800;
}

/** Top-level properties every action reads, so they carry no action prefix. */
const PREFIX_EXEMPT: Readonly<Record<string, readonly string[]>> = {
  try_it: ["builder", "expectedRevision"],
  languages: ["builder", "expectedRevision"],
  documents: ["builder", "expectedRevision", "kind"],
  remove_part: ["builder", "expectedRevision", "kind", "id"],
  drafts: ["form", "expectedRevision"]
};

/** A non-exempt property's description: the actions that read it, then a colon. */
const ACTION_PREFIX = /^(?:pdf_layout only, |journey only, )?[a-z_]+(?:, [a-z_]+)*(?: only)?: /u;

/** The actions a prefixed description names. */
function actionsNamed(description: string): string[] {
  const head = (description.match(ACTION_PREFIX)?.[0] ?? "").replace(/^(?:pdf_layout only, |journey only, )/u, "").replace(/: $/u, "").replace(/ only$/u, "");
  return head === "" ? [] : head.split(", ");
}

/** Every property at any depth (inside `properties` and `items`), with its dotted path. */
function propertiesOf(schema: unknown, path = ""): Array<{ path: string; property: Record<string, unknown> }> {
  const out: Array<{ path: string; property: Record<string, unknown> }> = [];
  if (typeof schema !== "object" || schema === null) {
    return out;
  }
  const record = schema as Record<string, unknown>;
  for (const [key, property] of Object.entries((record.properties as Record<string, Record<string, unknown>> | undefined) ?? {})) {
    const at = path === "" ? key : `${path}.${key}`;
    out.push({ path: at, property });
    out.push(...propertiesOf(property, at));
  }
  if (typeof record.items === "object" && record.items !== null) {
    out.push(...propertiesOf(record.items, `${path}[]`));
  }
  return out;
}

/**
 * The folded-action convention for one tool: the action key first,
 * required, a closed enum; every non-exempt top-level property prefixed with the actions that
 * read it, naming only actions of the enum; every property at any depth described.
 */
function expectFoldedConvention(entry: Entry): void {
  const key = FOLDED_TOOLS[entry.name] as string;
  const properties = entry.inputSchema.properties as Record<string, Record<string, unknown>>;
  expect(Object.keys(properties)[0], `${entry.name}: ${key} first`).toBe(key);
  expect((entry.inputSchema.required as string[] | undefined) ?? [], `${entry.name}: ${key} required`).toContain(key);
  const action = properties[key] as Record<string, unknown>;
  expect(action.type, entry.name).toBe("string");
  expect(Array.isArray(action.enum), `${entry.name}: ${key} is an enum`).toBe(true);
  const actions = action.enum as string[];
  const exempt = new Set([key, ...(PREFIX_EXEMPT[entry.name] ?? [])]);
  for (const [name, property] of Object.entries(properties)) {
    if (exempt.has(name)) {
      continue;
    }
    const description = property.description as string;
    expect(description, `${entry.name}.${name}: "${description}"`).toMatch(ACTION_PREFIX);
    for (const named of actionsNamed(description)) {
      expect(actions, `${entry.name}.${name} names "${named}"`).toContain(named);
    }
  }
  for (const { path, property } of propertiesOf(entry.inputSchema)) {
    expect(typeof property.description, `${entry.name}.${path} described`).toBe("string");
    expect((property.description as string).length, `${entry.name}.${path} described`).toBeGreaterThan(0);
  }
}
const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "enum", "items", "description", "minimum", "maximum", "maxLength"]);
const ALLOWED_ANNOTATIONS = new Set(["readOnlyHint", "consequentialHint", "untrustedContentHint"]);

interface Entry {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

function entries(): Entry[] {
  const runtime = agentRuntime(AGENT_JOURNEY_FORM);
  const catalogue = createFormAgentTools(runtimeAgentHost(runtime));
  const schemas = sessionToolSchemas();
  const tools: Entry[] = catalogue.tools.map((tool: AgentTool<Record<string, unknown>, unknown>) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations as Record<string, unknown>
  }));
  for (const name of SESSION_TOOL_NAMES) {
    tools.push({ name, title: SESSION_TOOL_TEXTS[name].title, description: SESSION_TOOL_TEXTS[name].description, inputSchema: schemas[name], annotations: { ...SESSION_TOOL_ANNOTATIONS } });
  }
  return tools;
}

/** Every keyword used anywhere in a schema object. */
function keywordsOf(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      keywordsOf(item, out);
    }
    return out;
  }
  if (typeof schema !== "object" || schema === null) {
    return out;
  }
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const property of Object.values(value as Record<string, unknown>)) {
        keywordsOf(property, out);
      }
    } else if (key === "items") {
      keywordsOf(value, out);
    }
  }
  return out;
}

describe("agent schema sanity (renderer catalogue + session pair)", () => {
  const all = entries();

  it("exposes exactly the twelve renderer tools in catalogue order, plus the session pair, fourteen in all", () => {
    const runtime = agentRuntime(AGENT_JOURNEY_FORM);
    expect(createFormAgentTools(runtimeAgentHost(runtime)).tools.map((tool) => tool.name)).toEqual([
      "describe_form",
      "get_answers",
      "get_options",
      "check",
      "set_answers",
      "edit_rows",
      "navigate",
      "set_locale",
      "submit",
      "undo_agent_changes",
      "drafts",
      "download_pdf"
    ]);
    expect([...FORM_AGENT_TOOL_NAMES]).toEqual(all.slice(0, 12).map((entry) => entry.name));
    expect(all).toHaveLength(14);
  });

  it("names match the pattern and are unique per page", () => {
    const names = all.map((entry) => entry.name);
    for (const name of names) {
      expect(name).toMatch(NAME_PATTERN);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("titles and descriptions are non-empty static English, descriptions at most 1,300 characters for a folded tool and 800 for any other", () => {
    for (const entry of all) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length, entry.name).toBeLessThanOrEqual(descriptionCap(entry.name));
    }
  });

  it("every folded tool follows the folded-action convention", () => {
    const folded = all.filter((item) => Object.prototype.hasOwnProperty.call(FOLDED_TOOLS, item.name));
    // The renderer's one folded tool is drafts (save, restore, clear); download_pdf is not folded.
    expect(folded.map((entry) => entry.name)).toEqual(["drafts"]);
    expect((folded[0]?.inputSchema.properties as Record<string, Record<string, unknown>>).action?.enum).toEqual(["save", "restore", "clear"]);
    for (const entry of folded) {
      expectFoldedConvention(entry);
    }
  });

  it("drafts and download_pdf declare no read action: every call of them is a consequential act", () => {
    const runtime = agentRuntime(AGENT_JOURNEY_FORM);
    const tools = createFormAgentTools(runtimeAgentHost(runtime)).tools;
    for (const tool of tools) {
      expect(tool.readActions, tool.name).toBeUndefined();
    }
  });

  it("every inputSchema is an object schema using only the allowed keyword subset", () => {
    for (const entry of all) {
      expect(entry.inputSchema.type).toBe("object");
      const used = keywordsOf(entry.inputSchema);
      for (const keyword of used) {
        expect(ALLOWED_KEYWORDS.has(keyword), `${entry.name} uses ${keyword}`).toBe(true);
      }
      for (const forbidden of ["minItems", "maxItems", "$ref", "$defs", "additionalProperties", "oneOf", "anyOf", "allOf", "default", "format", "pattern"]) {
        expect(used.has(forbidden), `${entry.name} uses ${forbidden}`).toBe(false);
      }
    }
  });

  it("every property has a description and `required` names existing properties", () => {
    for (const entry of all) {
      const properties = entry.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(typeof properties).toBe("object");
      for (const [key, property] of Object.entries(properties)) {
        expect(typeof property.description, `${entry.name}.${key}`).toBe("string");
        expect((property.description as string).length).toBeGreaterThan(0);
      }
      const required = (entry.inputSchema.required as string[] | undefined) ?? [];
      for (const name of required) {
        expect(Object.prototype.hasOwnProperty.call(properties, name), `${entry.name} requires ${name}`).toBe(true);
      }
    }
  });

  it("every renderer schema carries the `form` handle property with the stable wording", () => {
    for (const entry of all.slice(0, 12)) {
      const properties = entry.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(properties.form).toEqual({
        type: "string",
        description: "Which form, when the page has more than one: a handle from describe_form. Leave it out when there is one form."
      });
    }
  });

  it("annotations use only the three hint keys; reads are readOnly, submit, drafts and download_pdf are consequential, writes carry none", () => {
    for (const entry of all) {
      for (const key of Object.keys(entry.annotations)) {
        expect(ALLOWED_ANNOTATIONS.has(key), `${entry.name} annotation ${key}`).toBe(true);
      }
    }
    const byName = new Map(all.map((entry) => [entry.name, entry]));
    for (const name of ["describe_form", "get_answers", "get_options", "check"]) {
      expect(byName.get(name)?.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    }
    expect(byName.get("submit")?.annotations).toEqual({ consequentialHint: true });
    // A draft or a file leaves the page or cannot be taken back, and
    // their results carry the form's own words (a restored page's title, a file name).
    expect(byName.get("drafts")?.annotations).toEqual({ consequentialHint: true, untrustedContentHint: true });
    expect(byName.get("download_pdf")?.annotations).toEqual({ consequentialHint: true, untrustedContentHint: true });
    for (const name of ["set_answers", "edit_rows", "navigate", "set_locale", "undo_agent_changes", "begin_session", "end_session"]) {
      expect(byName.get(name)?.annotations).toEqual({});
    }
  });

  it("schemas hold no functions and round-trip through JSON", () => {
    for (const entry of all) {
      const text = JSON.stringify(entry.inputSchema);
      expect(JSON.parse(text)).toEqual(entry.inputSchema);
      expect(text.includes("function")).toBe(false);
    }
  });

  it("the session pair's title and description are the documented strings, read from session-tools.ts", () => {
    const begin = all.find((entry) => entry.name === "begin_session");
    const end = all.find((entry) => entry.name === "end_session");
    expect(begin?.title).toBe("Start a session");
    expect(end?.title).toBe("End the session");
    expect(begin?.description).toBe(SESSION_TOOL_TEXTS.begin_session.description);
    expect(end?.description).toBe(SESSION_TOOL_TEXTS.end_session.description);
  });

  it("the undo tool alone may run while the person has pressed Stop", () => {
    const runtime = agentRuntime(AGENT_JOURNEY_FORM);
    const tools = createFormAgentTools(runtimeAgentHost(runtime)).tools;
    expect(tools.filter((tool) => tool.allowedWhileStopped === true).map((tool) => tool.name)).toEqual(["undo_agent_changes"]);
  });
});

/**
 * The builder catalogue: the same checks over whatever
 * tools `createBuilderTools` returns, written generically so every check reaches all twenty-four:
 * uniqueness over the page's names (the renderer's and the builder's, counted from the
 * catalogues, never a literal), the annotation table looked up for every returned tool, failing
 * on one with no row, and the folded-action convention, `readActions` and input caps.
 */
describe("agent schema sanity (builder catalogue)", () => {
  const builderTools = createBuilderTools(createControllerHost(contactRequestController())).tools;
  const builderEntries: Entry[] = builderTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations as Record<string, unknown>
  }));

  /** The binding annotation table: replace_form echoes author text. */
  const ANNOTATIONS: Readonly<Record<string, Record<string, boolean>>> = {
    describe_builder: { readOnlyHint: true, untrustedContentHint: true },
    get_form: { readOnlyHint: true, untrustedContentHint: true },
    get_component: { readOnlyHint: true, untrustedContentHint: true },
    check_form: { readOnlyHint: true, untrustedContentHint: true },
    get_definition: { readOnlyHint: true, untrustedContentHint: true },
    list_tests: { readOnlyHint: true, untrustedContentHint: true },
    run_tests: { readOnlyHint: true, untrustedContentHint: true },
    list_component_types: { readOnlyHint: true },
    replace_form: { consequentialHint: true, untrustedContentHint: true },
    remove_components: { consequentialHint: true, untrustedContentHint: true },
    rename_component: { untrustedContentHint: true },
    write_test: { untrustedContentHint: true },
    add_components: {},
    set_properties: {},
    move_component: {},
    duplicate_component: {},
    open: {},
    history: {},
    remove_test: {},
    // The folded tools' annotations.
    try_it: { untrustedContentHint: true },
    languages: { untrustedContentHint: true },
    documents: { untrustedContentHint: true },
    remove_part: { consequentialHint: true, untrustedContentHint: true },
    save: { consequentialHint: true, untrustedContentHint: true }
  };

  it("lists the twenty-four names in order, and returns exactly them", () => {
    expect([...BUILDER_AGENT_TOOL_NAMES]).toEqual([
      "describe_builder",
      "get_form",
      "get_component",
      "list_component_types",
      "add_components",
      "replace_form",
      "set_properties",
      "rename_component",
      "move_component",
      "remove_components",
      "duplicate_component",
      "open",
      "history",
      "check_form",
      "get_definition",
      "list_tests",
      "write_test",
      "remove_test",
      "run_tests",
      "try_it",
      "languages",
      "documents",
      "remove_part",
      "save"
    ]);
    // The returned tools are the list, in its order.
    expect(builderEntries.map((entry) => entry.name)).toEqual([...BUILDER_AGENT_TOOL_NAMES]);
    expect(builderEntries).toHaveLength(BUILDER_AGENT_TOOL_NAMES.length);
    // Every builder tool has a row in the annotation table, and the table has no other row.
    expect(Object.keys(ANNOTATIONS).sort()).toEqual([...BUILDER_AGENT_TOOL_NAMES].sort());
  });

  it("names match the pattern and are unique on a page holding a form and a builder", () => {
    const page = [...entries(), ...builderEntries].map((entry) => entry.name);
    for (const name of page) {
      expect(name).toMatch(NAME_PATTERN);
    }
    // Counted from the catalogues: the renderer's names with the session pair, and the builder's.
    expect(page.length).toBe(entries().length + builderEntries.length);
    expect(new Set(page).size).toBe(page.length);
    expect(new Set(page).size).toBe(38);
  });

  it("titles and descriptions are non-empty static English, descriptions at most 1,300 characters for a folded tool and 800 for any other", () => {
    for (const entry of builderEntries) {
      expect(entry.title.length, entry.name).toBeGreaterThan(0);
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
      expect(entry.description.length, entry.name).toBeLessThanOrEqual(descriptionCap(entry.name));
    }
  });

  it("every folded tool follows the folded-action convention", () => {
    const folded = builderEntries.filter((entry) => Object.prototype.hasOwnProperty.call(FOLDED_TOOLS, entry.name));
    expect(folded.map((entry) => entry.name)).toEqual(["try_it", "languages", "documents", "remove_part"]);
    for (const entry of folded) {
      expectFoldedConvention(entry);
    }
  });

  it("every top-level property has a type, but fromData, the one untyped property", () => {
    for (const entry of builderEntries) {
      for (const [key, property] of Object.entries(entry.inputSchema.properties as Record<string, Record<string, unknown>>)) {
        if (key === "fromData") {
          expect(["add_components", "replace_form"], `${entry.name}.fromData`).toContain(entry.name);
          expect(property.type, `${entry.name}.fromData`).toBeUndefined();
          continue;
        }
        expect(typeof property.type, `${entry.name}.${key} has a type`).toBe("string");
      }
    }
  });

  it("no builder descriptor spells the renderer's write tool's name (guard 15's sentinel)", () => {
    for (const entry of builderEntries) {
      const text = JSON.stringify([entry.name, entry.title, entry.description, entry.inputSchema]);
      expect(text.includes("set_answers"), entry.name).toBe(false);
    }
  });

  it("every inputSchema is an object schema using only the allowed keyword subset", () => {
    for (const entry of builderEntries) {
      expect(entry.inputSchema.type).toBe("object");
      const used = keywordsOf(entry.inputSchema);
      for (const keyword of used) {
        expect(ALLOWED_KEYWORDS.has(keyword), `${entry.name} uses ${keyword}`).toBe(true);
      }
      for (const forbidden of ["minItems", "maxItems", "$ref", "$defs", "additionalProperties", "oneOf", "anyOf", "allOf", "default", "format", "pattern"]) {
        expect(used.has(forbidden), `${entry.name} uses ${forbidden}`).toBe(false);
      }
    }
  });

  it("every top-level property has a description, `required` names existing properties, and the handle property has the stable wording", () => {
    for (const entry of builderEntries) {
      const properties = entry.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(typeof properties).toBe("object");
      for (const [key, property] of Object.entries(properties)) {
        expect(typeof property.description, `${entry.name}.${key}`).toBe("string");
        expect((property.description as string).length).toBeGreaterThan(0);
      }
      const required = (entry.inputSchema.required as string[] | undefined) ?? [];
      for (const name of required) {
        expect(Object.prototype.hasOwnProperty.call(properties, name), `${entry.name} requires ${name}`).toBe(true);
      }
      expect(properties.builder, entry.name).toEqual({
        type: "string",
        description: "Which builder, when the page has more than one: a handle from describe_builder. Leave it out when there is one builder."
      });
      // The session pair's own `builder` property says the same (one wording per page).
      expect(properties.builder).toEqual((sessionToolSchemas().begin_session.properties as Record<string, unknown>).builder);
    }
  });

  it("annotations use only the three hint keys and follow the table, for every returned tool", () => {
    for (const entry of builderEntries) {
      for (const key of Object.keys(entry.annotations)) {
        expect(ALLOWED_ANNOTATIONS.has(key), `${entry.name} annotation ${key}`).toBe(true);
      }
      const row = ANNOTATIONS[entry.name];
      expect(row, `${entry.name} has a row in the annotation table`).toBeDefined();
      expect(entry.annotations, entry.name).toEqual(row);
    }
  });

  it("schemas hold no functions and round-trip through JSON", () => {
    for (const entry of builderEntries) {
      const text = JSON.stringify(entry.inputSchema);
      expect(JSON.parse(text)).toEqual(entry.inputSchema);
      expect(text.includes("function")).toBe(false);
    }
  });

  it("open alone runs while stopped; add_components, replace_form, try_it and languages take 512 KB of input", () => {
    expect(builderTools.filter((tool) => tool.allowedWhileStopped === true).map((tool) => tool.name)).toEqual(["open"]);
    for (const tool of builderTools) {
      if (["add_components", "replace_form", "try_it", "languages"].includes(tool.name)) {
        expect(tool.inputBytes, tool.name).toBe(524288);
      } else {
        expect(tool.inputBytes, tool.name).toBeUndefined();
      }
    }
  });

  it("the read actions of the folded tools are declared, and no other tool has any", () => {
    const declared = Object.fromEntries(builderTools.filter((tool) => tool.readActions !== undefined).map((tool) => [tool.name, tool.readActions]));
    expect(declared).toEqual({
      try_it: { key: "action", values: ["read"] },
      languages: { key: "action", values: ["list", "texts"] },
      documents: { key: "action", values: ["list"] }
    });
    for (const [name, readActions] of Object.entries(declared)) {
      const tool = builderTools.find((item) => item.name === name);
      const actions = ((tool?.inputSchema.properties as Record<string, { enum?: string[] }>).action?.enum ?? []) as string[];
      for (const value of (readActions as { values: readonly string[] }).values) {
        expect(actions, `${name} reads ${value}`).toContain(value);
      }
    }
  });
});
