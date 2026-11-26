import { describe, expect, it, vi } from "vitest";

import { BUILDER_AGENT_TOOL_NAMES, createBuilderTools } from "../form-engine/agent/builder/tools.js";
import { createControllerHost, type BuilderToolUi, type TestsChunk } from "../form-engine/agent/builder/host.js";
import { RESULT_BYTE_LIMIT, jsonByteLength } from "../form-engine/agent/result-caps.js";
import { SESSION_TOOL_NAMES } from "../form-engine/agent/session-tools.js";
import { SHARED_REFUSAL_CODES } from "../form-engine/agent/tool-types.js";
import { createTestsRunner } from "../form-engine/builder/form-tests/tests-runner.js";
import { createTestsNaming, createTestsWords } from "../form-engine/builder/form-tests/tests-words.js";
import { fakePage, type FakePage } from "./fixtures/agent-builder-adapters.js";
import { documentController } from "./fixtures/agent-builder-documents-fakes.js";
import { tableRoot, tryPage, type TryPage } from "./fixtures/agent-builder-try-fakes.js";
import { agentBuilder, contactRequestController, uiStub } from "./fixtures/agent-builder.js";

/**
 * The envelope every builder result carries:
 * `tool`,
 * `builder` and `revision` on every result about the one builder, JSON round-trip equality for all
 * twenty-four tools and every action of every folded tool over the contact-request fixture, and a
 * fuzz set (wrong types, nulls, huge strings, cycles, prototype keys, an action outside the enum,
 * an argument only another kind reads) for which no tool rejects or throws. Every refusal carries
 * a code from the closed tables. This is the guarantee that nothing leaves a
 * tool's `execute` but an envelope (the registrar's catch-all, proved here for
 * the builder).
 *
 * The round trip compares with `toStrictEqual`, not `toEqual`: the envelope bans `undefined`
 * members and non-plain values in a result, and `toEqual` skips an `undefined` key and ignores a
 * prototype, so only the strict matcher catches either one.
 */

type Row = Record<string, unknown>;

/** The tests chunk's real modules, as `host.loadTests` would hand them (direct imports are fine in vitest). */
const REAL_CHUNK: TestsChunk = { createTestsRunner, createTestsWords, createTestsNaming };

const PASSING = 'test "Sales leaves the message optional"\n  set topic = "sales"\n  expect message optional\n';
const FAILING = 'test "Sales makes the message required"\n  set topic = "sales"\n  expect message required\n';

/** Every name a builder page answers: the twenty-four and the session pair. */
const ALL_NAMES: readonly string[] = [...BUILDER_AGENT_TOOL_NAMES, ...SESSION_TOOL_NAMES];

/**
 * The codes a builder refusal may carry: the shared refusal codes, the builder's closed table
 * and its additions (the renderer's names
 * the try body reuses among them). A code outside this set is a contract break, whatever it says.
 */
const BUILDER_CODES: ReadonlySet<string> = new Set([
  ...SHARED_REFUSAL_CODES,
  // the builder's closed table
  "unsaved-draft",
  "try-it-on",
  "wrong-mode",
  "unknown-component",
  "unknown-type",
  "invalid-id",
  "duplicate-id",
  "slot-refused",
  "data-path-conflict",
  "blocked-property",
  "structure-limit",
  "formula-error",
  "has-dependents",
  "move-refused",
  "root-component",
  "fixed-component",
  "beyond-own",
  "undo-failed",
  "refused",
  "unknown-test",
  "test-parse-error",
  "duplicate-test-name",
  "no-ui",
  // the builder's additions
  "not-tryable",
  "try-it-busy",
  "tried-answers",
  "unknown-field",
  "not-writable",
  "invalid-value",
  "no-such-option",
  "option-ambiguous",
  "options-loading",
  "no-such-row",
  "rows-locked",
  "rows-limit",
  "person-data",
  "field-in-use",
  "nothing-written",
  "not-a-journey",
  "unknown-page",
  "blocked",
  "at-end",
  "at-start",
  "unknown-source",
  "locale-unsupported",
  "invalid-language-code",
  "source-locale-needed",
  "unknown-text",
  "read-only-text",
  "unknown-document",
  "unknown-template",
  "document-not-open",
  "not-a-template",
  "nothing-to-restore",
  "data-unreadable",
  "protected-setting",
  "no-save",
  "save-failed",
  "already-saved"
]);

/**
 * The codes a per-item refusal may carry, per tool: the items of `refused` on an ok result and of
 * `details.refused` on `nothing-written`. try_it's are the "per item in
 * `refused`" list, languages' the "per entry" one. A tool missing here that hands back a
 * per-item list fails the check, so a new list is added to the documented codes and this table first.
 */
const BUILDER_ITEM_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  try_it: new Set([
    "unknown-field",
    "not-writable",
    "invalid-value",
    "no-such-option",
    "option-ambiguous",
    "options-loading",
    "no-such-row",
    "rows-locked",
    "rows-limit",
    "person-data",
    "field-in-use"
  ]),
  languages: new Set(["unknown-text", "read-only-text", "locale-unsupported", "chunk-unavailable"])
};

/**
 * Every per-item refusal of a result (ok or not) is typed and carries a code from its tool's
 * per-item table. The envelope's own code is `expectRefusalShape`'s; this walks the items under it.
 */
function expectItemRefusals(result: Row, where: string): void {
  const details = result.details !== null && typeof result.details === "object" ? (result.details as Row) : undefined;
  for (const list of [result.refused, details?.refused]) {
    if (list === undefined) {
      continue;
    }
    expect(Array.isArray(list), `${where}: a per-item refusal list`).toBe(true);
    const allowed = BUILDER_ITEM_CODES[result.tool as string];
    expect(allowed, `${where}: ${String(result.tool)} has no per-item refusal table`).toBeDefined();
    for (const item of list as Row[]) {
      expect(typeof item.code, where).toBe("string");
      expect(typeof item.message, where).toBe("string");
      expect(typeof item.hint, where).toBe("string");
      expect(allowed?.has(item.code as string), `${where}: per-item code ${String(item.code)}`).toBe(true);
    }
  }
}

/** The folded tools' action key (`remove_part`'s `kind` plays the action's role) and its values, read from each schema. */
function foldedActions(): Map<string, { key: string; values: string[]; kinds?: string[] }> {
  const out = new Map<string, { key: string; values: string[]; kinds?: string[] }>();
  for (const tool of createBuilderTools(createControllerHost(contactRequestController())).tools) {
    const properties = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
    const action = properties.action?.enum;
    if (action !== undefined) {
      const kinds = properties.kind?.enum;
      out.set(tool.name, { key: "action", values: [...action], ...(kinds !== undefined ? { kinds: [...kinds] } : {}) });
    } else if (properties.kind?.enum !== undefined) {
      out.set(tool.name, { key: "kind", values: [...properties.kind.enum] });
    }
  }
  return out;
}

/** Each tool's schema properties, for the schema-driven fuzz (every property given each wrong value). */
function schemaProperties(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tool of createBuilderTools(createControllerHost(contactRequestController())).tools) {
    out.set(tool.name, Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));
  }
  return out;
}

/** The full page: Try it (one flag for the shell and the adapter), both designers ready, the document waiter, the site's templates and its Save. */
interface FullPage {
  page: TryPage;
  fakes: FakePage;
}

function fullPage(): FullPage {
  const page = tryPage();
  const fakes = fakePage(page.controller, { tryIt: false });
  const ui = page.builder.host.ui as BuilderToolUi;
  ui.journeys = () => fakes.journeys.side();
  ui.pdfLayouts = () => fakes.pdf.side();
  ui.selectDocument = fakes.ui.selectDocument as NonNullable<BuilderToolUi["selectDocument"]>;
  ui.pdfTemplates = fakes.ui.pdfTemplates as NonNullable<BuilderToolUi["pdfTemplates"]>;
  page.stub.state.saveLabel = "Save";
  page.stub.state.saveOutcome = { status: "saved", localeChanges: { removed: [], renamed: [] } };
  return { page, fakes };
}

/** The template layout `cra-t2125` open in the PDF designer with its PDF read (four fields), as map_fields and create_form_fields need it. */
function openTemplate(fakes: FakePage): void {
  fakes.pdf.designer.openId = "cra-t2125";
  fakes.pdf.state.open = { id: "cra-t2125", ready: true, template: { fields: 4 } };
  fakes.pdf.state.layoutController = documentController();
  fakes.pdf.state.mappings = 3;
}

/** A fresh builder with the page stub, the real tests chunk and the handle `contact-request`. */
function builderUnderTest() {
  return agentBuilder({ id: "contact-request", ui: uiStub(), host: { loadTests: async () => REAL_CHUNK } });
}

/** Inputs no builder tool may reject or throw for: wrong types, nulls, huge strings and prototype keys. */
function fuzzSet(): unknown[] {
  return [
    undefined,
    null,
    "",
    "a string",
    0,
    -1,
    1.5,
    Number.NaN,
    true,
    [],
    [1, "two", null],
    {},
    // Wrong types on the shared arguments.
    { builder: 7 },
    { builder: "ghost" },
    { expectedRevision: -1 },
    { expectedRevision: "1" },
    { expectedRevision: 1e15 },
    { dryRun: "yes" },
    // Component ids.
    { componentId: 42 },
    { componentId: "" },
    { componentId: null },
    { componentId: "ghost" },
    { componentId: "x".repeat(1_000_000) },
    { componentId: "email", newId: "Bad Id!" },
    { componentId: "email", newId: "x".repeat(200) },
    { componentId: "email", newId: "" },
    { componentId: "email", parentId: "ghost", slotId: "content" },
    { componentId: "email", parentId: "details", slotId: "nowhere", index: 1.5 },
    { componentId: "email", after: 3 },
    { componentId: "root" },
    { componentIds: "email" },
    { componentIds: [] },
    { componentIds: [null, 4] },
    { componentIds: ["ghost", "email", "email"], removeReferences: "yes" },
    // Specs.
    { components: null },
    { components: {} },
    { components: [null] },
    { components: [{}] },
    { components: [{ type: "ghost" }] },
    { components: [{ type: 7, label: [] }] },
    { components: [{ type: "text", children: "x" }] },
    { components: [{ type: "text", id: "Bad Id!", options: 5 }] },
    { components: [{ type: "select", options: [null, 4, { value: {} }] }] },
    { components: [{ type: "fieldset", children: [{ type: "text", children: [{ type: "text" }] }] }] },
    { components: [{ type: "text", rules: { visibleWhen: 5, requiredWhen: "topic = (" } }] },
    { components: [{ type: "text", label: "x".repeat(1_000_000) }] },
    { components: [{ type: "text" }], keep: "submit", slotId: 4 },
    // Property edits.
    { edits: null },
    { edits: [null] },
    { edits: [{ componentId: "email" }] },
    { edits: [{ componentId: "email", propertyPath: "", value: 1 }] },
    { edits: [{ componentId: "email", propertyPath: "rules.visibleWhen", value: 5 }] },
    { edits: [{ componentId: "email", propertyPath: "configuration.label", value: { deep: [1, { deeper: true }] } }] },
    { edits: [{ componentId: "email", propertyPath: "label", value: "x".repeat(1_000_000) }] },
    { edits: [{ componentId: "email", propertyPath: "label", value: "x" }], partial: 1 },
    // Workspaces, panels, history.
    { workspace: "pdf" },
    { workspace: "everywhere" },
    { panel: 7 },
    { tryIt: "yes" },
    { action: "sideways" },
    { action: "undo", steps: -1 },
    { action: "redo", steps: 1e9, beyondOwn: "yes" },
    // Reads.
    { detail: "everything" },
    { depth: -1 },
    { offset: -1 },
    { limit: 0 },
    { limit: 100_000 },
    { section: "ghost" },
    { severity: 3 },
    { type: "ghost", group: null },
    // Tests.
    { ids: "x" },
    { ids: [1, null] },
    { source: "" },
    { source: "test" },
    { source: 'test "Unclosed\n  set ghost = (\n' },
    { source: "x".repeat(1_000_000) },
    { id: "ghost" },
    { id: 4 },
    { timeBudgetMs: -5 },
    { timeBudgetMs: "soon" },
    // The session pair.
    { purpose: "x".repeat(5_000) },
    { purpose: 12 },
    { summary: 12 },
    { undo: "yes", summary: "ok" },
    // Prototype keys, own and nested (JSON.parse makes `__proto__` an own key, as a page's caller could).
    JSON.parse('{"__proto__": {"polluted": true}}') as unknown,
    JSON.parse('{"componentId": "email", "__proto__": {"polluted": true}}') as unknown,
    JSON.parse('{"components": [{"type": "text", "__proto__": {"polluted": true}}]}') as unknown,
    JSON.parse('{"edits": [{"componentId": "email", "propertyPath": "label", "value": {"__proto__": {"polluted": true}}}]}') as unknown,
    { componentId: "__proto__" },
    { componentId: "constructor" },
    { componentId: "email", newId: "__proto__" },
    { components: [{ type: "__proto__" }, { type: "constructor", id: "toString" }] },
    { edits: [{ componentId: "email", propertyPath: "__proto__.polluted", value: true }] },
    { edits: [{ componentId: "email", propertyPath: "configuration.constructor.prototype.polluted", value: true }] },
    { edits: [{ componentId: "__proto__", propertyPath: "label", value: "x" }] },
    { id: "__proto__", source: PASSING },
    { section: "constructor" },
    // The folded tools' actions and arguments (an action outside the enum, an argument
    // only another kind reads, wrong shapes inside the nested arguments).
    { action: "fill", answers: null },
    { action: "fill", answers: { full_name: "x".repeat(1_000_000) } },
    { action: "fill", answers: { ghost: 1, topic: { value: [] }, email: ["a", "b"] } },
    { action: "edit_rows", collection: 5, rowAction: "sideways" },
    { action: "edit_rows", collection: "ghost", rowAction: "remove", index: -1 },
    { action: "navigate", to: "" },
    { action: "settings", trySubmission: { delayMs: 1e9 }, sources: "x" },
    { action: "settings", sources: [{ sourceId: "ghost", options: [null, {}, 4] }, null] },
    { action: "translate", translations: [null, { textId: 5 }, { textId: "ghost", language: "fr-CA", text: "x" }] },
    { action: "translate", translations: [{ textId: "ghost", language: "fr-CA", text: "x".repeat(20_000) }] },
    { action: "add", code: "not a code!" },
    { action: "rename", code: "en", to: "en" },
    { action: "set_default", code: "ghost" },
    { action: "list", kind: "spreadsheet" },
    { action: "open", kind: "journey" },
    { action: "new", kind: "journey", from: "blank" },
    { action: "move", kind: "journey", id: "intake", toIndex: 0 },
    { action: "new", kind: "pdf_layout", shape: "sections" },
    { action: "new", kind: "pdf_layout", from: "template", templateId: "ghost" },
    { action: "preview_pdf", kind: "pdf_layout", answers: "everyone" },
    { kind: "language", id: "ghost" },
    { kind: "form", id: "root" },
    { kind: "pdf_layout", id: "" },
    { fromData: "{not json" },
    { fromData: "x".repeat(1_000_000) },
    { fromData: 5, components: [{ type: "text" }] },
    { fromData: "{}", components: [{ type: "text" }] },
    { binding: 7 },
    { binding: "ghost" },
    { section: "data-model", expectedRevision: 0 },
    { edits: [{ componentId: "root", target: "identity", propertyPath: "id", value: { deep: true } }] },
    { edits: [{ componentId: "root", target: "ghost", propertyPath: "version", value: "1" }] },
    { again: "yes" },
    JSON.parse('{"action": "fill", "answers": {"__proto__": {"polluted": true}}}') as unknown,
    JSON.parse('{"action": "translate", "translations": [{"__proto__": {"polluted": true}, "textId": "x", "language": "fr-CA", "text": "y"}]}') as unknown,
    JSON.parse('{"action": "settings", "sources": [{"sourceId": "__proto__", "options": ["a"]}]}') as unknown,
    { action: "add", code: "__proto__" },
    { action: "open", kind: "journey", id: "__proto__" },
    { kind: "journey", id: "constructor" }
  ];
}

/**
 * The arguments each action runs with in the schema-driven fuzz before one property is swapped
 * for a wrong value, so the swap reaches the body rather than stopping at a missing argument.
 * Keyed `tool:action` or `tool:action:kind`; an action not listed runs with its key alone.
 */
const GOOD_ARGUMENTS: Readonly<Record<string, Row>> = {
  "try_it:fill": { answers: { full_name: "Ana", topic: "sales" } },
  "try_it:edit_rows": { collection: "ghost", rowAction: "add" },
  "try_it:navigate": { to: "next" },
  "try_it:settings": { trySubmission: { outcome: "accept" }, sources: [{ sourceId: "provinces", options: ["on"] }] },
  "try_it:clear": { discardTriedAnswers: true },
  "try_it:read": { include: "all", offset: 0, limit: 5 },
  "languages:texts": { group: "fields", limit: 5 },
  "languages:translate": { translations: [{ textId: "ghost", language: "fr-CA", text: "x" }] },
  "languages:add": { code: "it", label: "Italiano", sourceLocale: "en" },
  "languages:rename": { code: "it", to: "it-CH" },
  "languages:relabel": { code: "fr-CA", label: "Français" },
  "languages:set_default": { code: "en" },
  "languages:preview": { code: "fr-CA" },
  "documents:open:journey": { id: "intake" },
  "documents:open:pdf_layout": { id: "cra-t2125" },
  "documents:new:journey": { name: "Fuzzed", shape: "sections" },
  "documents:new:pdf_layout": { name: "Fuzzed", from: "blank" },
  "documents:duplicate:journey": { id: "intake" },
  "documents:duplicate:pdf_layout": { id: "summary" },
  "documents:rename:journey": { id: "intake", name: "Renamed" },
  "documents:rename:pdf_layout": { id: "summary", name: "Renamed" },
  "documents:set_default:journey": { id: "intake" },
  "documents:set_default:pdf_layout": { id: "summary" },
  "documents:move:pdf_layout": { id: "summary", toIndex: 0 },
  "documents:preview_pdf:pdf_layout": { id: "summary", answers: "tried" },
  "documents:restore_removed:journey": { id: "intake" },
  "documents:restore_removed:pdf_layout": { id: "summary" },
  "remove_part:language": { id: "ghost" },
  "remove_part:journey": { id: "ghost" },
  "remove_part:pdf_layout": { id: "ghost" },
  "history:undo": { steps: 1 },
  "history:redo": { steps: 1 }
};

/** Wrong values the schema-driven fuzz gives each property of each action in turn. */
const WRONG_VALUES: readonly unknown[] = [null, 7, -1, 1.5, "", "ghost", true, [], [null], {}, { deep: { deeper: [1] } }, "x".repeat(70_000)];

/**
 * Inputs JSON cannot hold: an in-page caller can hand `execute()` a cycle. The registrar answers
 * one it cannot serialise as `internal` and drops one under an unknown
 * top-level key; either way the call resolves to an envelope.
 */
function cycles(): unknown[] {
  const top: Row = { componentId: "email" };
  top.self = top;
  const node: Row = { type: "fieldset", label: "Loop" };
  node.children = [node];
  const value: Row = { label: "Loop" };
  value.again = value;
  const list: unknown[] = [];
  list.push(list);
  return [
    top,
    { components: [node] },
    { edits: [{ componentId: "email", propertyPath: "configuration.label", value }] },
    { componentIds: list },
    { ids: list },
    { purpose: "Cycle", extra: top },
    { action: "fill", answers: value },
    { action: "translate", translations: list },
    { action: "settings", sources: [{ sourceId: "provinces", options: list }] },
    { action: "list", kind: "journey", extra: top },
    { kind: "language", id: "fr-CA", extra: value }
  ];
}

/** A refusal's envelope fields are all there and typed, and its code is one of the closed tables. */
function expectRefusalShape(result: Row, where: string): void {
  expect(typeof result.code, where).toBe("string");
  expect(typeof result.message, where).toBe("string");
  expect(typeof result.hint, where).toBe("string");
  expect(typeof result.retryable, where).toBe("boolean");
  expect(BUILDER_CODES.has(result.code as string), `${where}: code ${String(result.code)}`).toBe(true);
}

/** The first calls of the round trip: each row names the outcome it gets ("ok" or the refusal's code). */
const PHASE2_NAMES: readonly string[] = BUILDER_AGENT_TOOL_NAMES.slice(0, 19);

describe("builder envelope", () => {
  it("every result carries tool, builder and revision and survives a JSON round trip, for the first tools and the session pair over the fixture", async () => {
    const builder = builderUnderTest();
    // Each row names the outcome it gets ("ok" or the refusal's code). A regression that turns a
    // success into a refusal (or an earlier call that stops creating "phone", so the later ones
    // answer unknown-component) would otherwise swap a success payload for a small refusal and
    // silently drop that payload from the round trip.
    const calls: Array<[string, unknown, string]> = [
      ["describe_builder", {}, "ok"],
      ["get_form", {}, "ok"],
      ["get_form", { componentId: "details", detail: "full" }, "ok"],
      ["get_component", { componentId: "message" }, "ok"],
      ["get_component", { componentId: "ghost" }, "unknown-component"],
      ["list_component_types", {}, "ok"],
      ["list_component_types", { type: "select", detail: "full" }, "ok"],
      ["get_definition", {}, "ok"],
      ["get_definition", { section: "all" }, "ok"],
      ["check_form", {}, "ok"],
      ["check_form", { severity: "all" }, "ok"],
      ["list_tests", { includeSource: true }, "ok"],
      ["begin_session", { purpose: "Round trip" }, "ok"],
      ["add_components", { components: [{ type: "text", id: "phone", label: "Phone" }] }, "ok"],
      ["add_components", { components: [{ type: "fieldset", label: "Extra", children: [{ type: "text", label: "Inside" }] }], dryRun: true }, "ok"],
      ["add_components", { components: [{ type: "text", label: "Bad rule", rules: { visibleWhen: "topic = (" } }] }, "formula-error"],
      ["set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "Email address" }] }, "ok"],
      ["set_properties", { edits: [{ componentId: "email", propertyPath: "rules.visibleWhen", value: "topic = (" }] }, "formula-error"],
      ["rename_component", { componentId: "phone", newId: "phone_number" }, "ok"],
      ["move_component", { componentId: "phone_number", parentId: "details", slotId: "content", index: 0 }, "ok"],
      ["move_component", { componentId: "phone_number", parentId: "ghost" }, "unknown-component"],
      ["duplicate_component", { componentId: "phone_number" }, "ok"],
      ["remove_components", { componentIds: ["phone_number"] }, "ok"],
      ["remove_components", { componentIds: ["topic"] }, "has-dependents"],
      ["history", { action: "undo" }, "ok"],
      ["history", { action: "redo" }, "ok"],
      ["history", { action: "undo", steps: 50 }, "beyond-own"],
      ["write_test", { source: PASSING }, "ok"],
      ["write_test", { source: PASSING }, "duplicate-test-name"],
      ["write_test", { source: "test" }, "test-parse-error"],
      ["list_tests", {}, "ok"],
      ["run_tests", {}, "ok"],
      ["run_tests", { source: FAILING }, "ok"],
      ["remove_test", { id: "test-1" }, "ok"],
      ["remove_test", { id: "ghost" }, "unknown-test"],
      ["open", { componentId: "email" }, "ok"],
      ["open", { workspace: "logic", panel: "variables" }, "ok"],
      ["open", { workspace: "pdf" }, "ok"],
      ["open", { workspace: "form", panel: "components" }, "ok"],
      ["replace_form", { components: [{ type: "text", id: "only", label: "Only" }], dryRun: true }, "ok"],
      ["replace_form", { components: [{ type: "text", id: "only", label: "Only" }], keep: ["submit"] }, "ok"],
      ["get_form", { expectedRevision: 1 }, "ok"],
      ["end_session", { summary: "Done", undo: true }, "ok"],
      ["describe_builder", {}, "ok"]
    ];
    const seen = new Set<string>();
    for (const [name, input, outcome] of calls) {
      const where = `${name} ${JSON.stringify(input)}`;
      const result = (await builder.execute(name, input)) as Row;
      seen.add(name);
      expect(typeof result.ok, where).toBe("boolean");
      expect(result.ok === true ? "ok" : result.code, where).toBe(outcome);
      expect(result.tool, where).toBe(name);
      expectItemRefusals(result, where);
      expect(result.builder, where).toBe("contact-request");
      expect(typeof result.revision, where).toBe("number");
      if (result.ok === false) {
        expectRefusalShape(result, where);
        expect(result.code, where).not.toBe("internal");
      }
      expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
      expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    }
    for (const name of [...PHASE2_NAMES, ...SESSION_TOOL_NAMES]) {
      expect(seen.has(name), name).toBe(true);
    }
  });

  it("every later tool and every action of every folded tool answers an envelope that survives a JSON round trip, over the full page", { timeout: 60_000 }, async () => {
    const { page, fakes } = fullPage();
    const builder = page.builder;
    let textId = "";
    // `items` marks an ok row that must carry a non-empty `refused`, so the per-item walk runs over
    // real items on a success (otherwise only nothing-written's `details.refused` would feed it).
    type Call = { name: string; input: () => unknown; outcome: string; before?: () => void; items?: true };
    const call = (name: string, input: unknown, outcome: string, before?: () => void): Call => ({ name, input: () => input, outcome, ...(before !== undefined ? { before } : {}) });
    // Each row pins its outcome, as the first round trip does; the refusals among them are the
    // body's own answers (the documented codes), so a body that stops being reached shows here.
    const calls: Call[] = [
      call("describe_builder", {}, "ok"),
      call("begin_session", { purpose: "Later tools round trip" }, "ok"),
      call("try_it", { action: "read" }, "ok"),
      call("try_it", { action: "fill", answers: { full_name: "Ana", topic: "other" } }, "ok"),
      { ...call("try_it", { action: "fill", answers: { full_name: "Ana", ghost: 1 } }, "ok"), items: true },
      call("try_it", { action: "edit_rows", collection: "ghost", rowAction: "add" }, "unknown-field"),
      call("try_it", { action: "navigate", to: "next" }, "not-a-journey"),
      call("try_it", { action: "check" }, "ok"),
      call("try_it", { action: "submit" }, "ok"),
      call("try_it", { action: "settings", trySubmission: { outcome: "refuse", refusalMessage: "No" }, sources: [{ sourceId: "provinces", options: ["on", { value: "qc", label: "Québec" }] }] }, "ok"),
      call("try_it", { action: "clear", discardTriedAnswers: true }, "ok"),
      call("open", { tryIt: false }, "ok"),
      call("languages", { action: "list" }, "ok"),
      call("languages", { action: "texts", group: "fields", limit: 5 }, "ok"),
      { name: "languages", input: () => ({ action: "translate", translations: [{ textId, language: "fr-CA", text: "Nom complet" }] }), outcome: "ok" },
      {
        name: "languages",
        input: () => ({ action: "translate", translations: [{ textId, language: "fr-CA", text: "Nom" }, { textId: "ghost", language: "fr-CA", text: "x" }] }),
        outcome: "ok",
        items: true
      },
      call("languages", { action: "add", code: "de", label: "Deutsch" }, "ok"),
      call("languages", { action: "rename", code: "de", to: "de-CH" }, "ok"),
      call("languages", { action: "relabel", code: "de-CH", label: "Swiss German" }, "ok"),
      call("languages", { action: "preview", code: "fr-CA" }, "ok"),
      call("languages", { action: "set_default", code: "fr-CA" }, "ok"),
      call("languages", { action: "translate", translations: [{ textId: "ghost", language: "fr-CA", text: "x" }] }, "nothing-written"),
      call("documents", { action: "list", kind: "journey" }, "ok"),
      call("documents", { action: "open", kind: "journey", id: "intake" }, "ok"),
      call("documents", { action: "new", kind: "journey", name: "Second", shape: "sections" }, "ok"),
      call("documents", { action: "duplicate", kind: "journey", id: "intake" }, "ok"),
      call("documents", { action: "rename", kind: "journey", id: "intake", name: "Intake two" }, "ok"),
      call("documents", { action: "set_default", kind: "journey", id: "journey-1" }, "ok"),
      call("documents", { action: "list", kind: "pdf_layout" }, "ok"),
      call("documents", { action: "open", kind: "pdf_layout", id: "summary" }, "ok"),
      call("documents", { action: "new", kind: "pdf_layout", from: "blank", name: "Blank" }, "ok"),
      call("documents", { action: "new", kind: "pdf_layout", from: "template", templateId: "t2125-2026" }, "ok"),
      call("documents", { action: "duplicate", kind: "pdf_layout", id: "summary" }, "ok"),
      call("documents", { action: "rename", kind: "pdf_layout", id: "summary", name: "Short summary" }, "ok"),
      call("documents", { action: "set_default", kind: "pdf_layout", id: "cra-t2125" }, "ok"),
      call("documents", { action: "move", kind: "pdf_layout", id: "summary", toIndex: 1 }, "ok"),
      call("documents", { action: "preview_pdf", kind: "pdf_layout", id: "summary" }, "ok"),
      call("documents", { action: "map_fields", kind: "pdf_layout" }, "ok", () => openTemplate(fakes)),
      call("documents", { action: "create_form_fields", kind: "pdf_layout" }, "ok"),
      call("documents", { action: "move", kind: "journey", id: "intake", toIndex: 0 }, "bad-input"),
      call("remove_part", { kind: "language", id: "de-CH" }, "ok"),
      call("remove_part", { kind: "journey", id: "intake" }, "ok"),
      call("documents", { action: "restore_removed", kind: "journey", id: "intake" }, "ok"),
      call("remove_part", { kind: "pdf_layout", id: "summary" }, "ok"),
      call("documents", { action: "restore_removed", kind: "pdf_layout", id: "summary" }, "ok"),
      call("documents", { action: "restore_removed", kind: "pdf_layout", id: "summary" }, "nothing-to-restore"),
      call("remove_part", { kind: "journey", id: "ghost" }, "unknown-document"),
      call("get_definition", { section: "data-model" }, "ok"),
      call("add_components", { fromData: '{"budget": 12}' }, "ok"),
      call("add_components", { fromData: "{not json" }, "data-unreadable"),
      call("set_properties", { edits: [{ componentId: "root", target: "identity", propertyPath: "version", value: "1.1.0" }] }, "ok"),
      call("open", { binding: "gcds" }, "ok"),
      call("save", {}, "ok"),
      call("save", {}, "already-saved"),
      call("end_session", { summary: "Done", undo: true }, "ok"),
      call("describe_builder", {}, "ok")
    ];
    const seen = new Set<string>();
    const actions = new Set<string>();
    for (const row of calls) {
      row.before?.();
      const input = row.input() as Row;
      const where = `${row.name} ${JSON.stringify(input)}`;
      const result = (await builder.execute(row.name, input)) as Row;
      seen.add(row.name);
      expect(typeof result.ok, where).toBe("boolean");
      expect(result.ok === true ? "ok" : result.code, `${where}: ${String(result.message)}`).toBe(row.outcome);
      expect(result.tool, where).toBe(row.name);
      expectItemRefusals(result, where);
      if (row.items === true) {
        expect(Array.isArray(result.refused) && (result.refused as unknown[]).length > 0, `${where}: per-item refusals on an ok result`).toBe(true);
      }
      expect(result.builder, where).toBe("builder-1");
      expect(typeof result.revision, where).toBe("number");
      if (result.ok === false) {
        expectRefusalShape(result, where);
        expect(result.code, where).not.toBe("internal");
      }
      // The body was reached: an ok, or a refusal of its own (not the argument check's, not a
      // missing page or chunk).
      if (result.ok === true || !["bad-input", "no-ui", "chunk-unavailable", "feature-off"].includes(result.code as string)) {
        actions.add(`${row.name}:${String(input.action ?? input.kind ?? "")}:${String(input.action !== undefined ? (input.kind ?? "") : "")}`);
      }
      expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
      expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
      if (row.name === "languages" && input.action === "texts") {
        textId = ((result.texts as Row[] | undefined)?.[0]?.textId as string | undefined) ?? "";
        expect(textId, "the texts page names a text").not.toBe("");
      }
    }
    // Every later tool ran, and with the first round trip the two lists cover every name.
    for (const name of BUILDER_AGENT_TOOL_NAMES.slice(19)) {
      expect(seen.has(name), name).toBe(true);
    }
    expect(new Set([...PHASE2_NAMES, ...SESSION_TOOL_NAMES, ...seen])).toEqual(new Set(ALL_NAMES));
    // Every action of every folded tool reached its body at least once (documents for each kind
    // that has it; remove_part's kind is its action), read from the schemas, so a new action
    // fails here until a row covers it. The journey kind has no move, map_fields,
    // create_form_fields or preview_pdf: the folded check refuses those bad-input (the row above).
    // history's undo / redo are in the round trip above.
    const folded = new Map([...foldedActions()].filter(([name]) => name !== "history"));
    expect([...folded.keys()].sort()).toEqual(["documents", "languages", "remove_part", "try_it"]);
    const PDF_ONLY_ACTIONS = new Set(["move", "map_fields", "create_form_fields", "preview_pdf"]);
    for (const [name, spec] of folded) {
      for (const value of spec.values) {
        if (spec.key === "kind") {
          expect(actions.has(`${name}:${value}:`), `${name} kind ${value}`).toBe(true);
          continue;
        }
        for (const kind of spec.kinds ?? [""]) {
          if (kind === "journey" && PDF_ONLY_ACTIONS.has(value)) {
            continue;
          }
          expect(actions.has(`${name}:${value}:${kind}`), `${name} ${value}${kind !== "" ? ` (${kind})` : ""}`).toBe(true);
        }
      }
    }
  });

  it("try_it edit_rows reaches its ok body on a page with a table: an added row with refused cells round-trips and its items carry the item-refusal codes", async () => {
    // The full page has no table, so the round trip above only reaches edit_rows' unknown-field
    // refusal; this is its ok payload (written, refused, rows, next) under the same checks.
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true } });
    const input = { action: "edit_rows", collection: "items", rowAction: "add", values: { qty: "abc", ghost: 1, note: "n" } };
    const where = `try_it ${JSON.stringify(input)}`;
    const result = (await page.builder.execute("try_it", input)) as Row;
    expect(result.ok === true ? "ok" : result.code, `${where}: ${String(result.message)}`).toBe("ok");
    expect(result.tool, where).toBe("try_it");
    expect(result.builder, where).toBe("builder-1");
    expect(typeof result.revision, where).toBe("number");
    expectItemRefusals(result, where);
    expect(Array.isArray(result.refused) && (result.refused as unknown[]).length > 0, `${where}: per-item refusals on an ok result`).toBe(true);
    expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
    expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("the bare controller (no page around it, no tests chunk) answers every tool with a round-tripping envelope", async () => {
    const builder = agentBuilder();
    for (const name of ALL_NAMES) {
      const result = (await builder.execute(name, {})) as Row;
      expect(typeof result.ok, name).toBe("boolean");
      expect(result.tool, name).toBe(name);
      expectItemRefusals(result, name);
      expect(result.builder, name).toBe("builder-1");
      expect(typeof result.revision, name).toBe("number");
      if (result.ok === false) {
        expectRefusalShape(result, name);
        expect(result.code, name).not.toBe("internal");
      }
      expect(JSON.parse(JSON.stringify(result)), name).toStrictEqual(result);
      expect(jsonByteLength(result), name).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    }
  });

  it("no tool rejects or throws for the fuzz set, on the stub page and on the full page; every answer is an envelope that round-trips", { timeout: 120_000 }, async () => {
    for (const [page, builder] of [
      ["stub page", builderUnderTest()],
      ["full page", fullPage().page.builder]
    ] as const) {
      for (const name of ALL_NAMES) {
        for (const input of fuzzSet()) {
          const where = `${page}: ${name} ${JSON.stringify(input)?.slice(0, 120)}`;
          // The registrar itself, not the fixture's `execute`, whose `input = {}` default would turn
          // the omitted-input (`undefined`) case into a second `{}`.
          const result = (await builder.registrar.execute(name, input)) as Row;
          expect(typeof result.ok, where).toBe("boolean");
          expect(result.tool, where).toBe(name);
          expectItemRefusals(result, where);
          if (result.ok === false) {
            expectRefusalShape(result, where);
            expect(result.code, where).not.toBe("internal");
          }
          expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
          expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
        }
      }
      // Nothing reached a prototype.
      expect(({} as Row).polluted).toBeUndefined();
      expect((Object.prototype as Row).polluted).toBeUndefined();
      // The builder still works afterwards.
      const described = (await builder.execute("describe_builder", {})) as Row;
      expect(described.ok, page).toBe(true);
      const form = (await builder.execute("get_form", {})) as Row;
      expect(form.ok, page).toBe(true);
    }
  });

  it("every action of every folded tool, each property given each wrong value in turn, answers an envelope; an action outside the enum and an argument of the other kind are bad-input", { timeout: 300_000 }, async () => {
    const { page, fakes } = fullPage();
    openTemplate(fakes);
    const builder = page.builder;
    const properties = schemaProperties();
    const codes = new Map<string, number>();
    for (const [name, spec] of foldedActions()) {
      for (const kind of spec.kinds ?? [undefined]) {
        for (const action of spec.values) {
          const good = GOOD_ARGUMENTS[`${name}:${action}${kind !== undefined ? `:${kind}` : ""}`] ?? {};
          const base: Row = { [spec.key]: action, ...(kind !== undefined ? { kind } : {}), ...good };
          const inputs: Row[] = [base];
          for (const key of properties.get(name) ?? []) {
            if (key === spec.key || (kind !== undefined && key === "kind")) {
              continue;
            }
            for (const value of WRONG_VALUES) {
              inputs.push({ ...base, [key]: value });
            }
          }
          for (const input of inputs) {
            const where = `${name} ${JSON.stringify(input).slice(0, 160)}`;
            const result = (await builder.registrar.execute(name, input)) as Row;
            expect(typeof result.ok, where).toBe("boolean");
            expect(result.tool, where).toBe(name);
            expectItemRefusals(result, where);
            const outcome = result.ok === true ? "ok" : (result.code as string);
            codes.set(outcome, (codes.get(outcome) ?? 0) + 1);
            if (result.ok === false) {
              expectRefusalShape(result, where);
              expect(result.code, where).not.toBe("internal");
            }
            expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
            expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
          }
        }
      }
      // An action outside the enum, for each folded tool.
      const outside = (await builder.registrar.execute(name, { [spec.key]: "sideways", ...(spec.kinds !== undefined ? { kind: spec.kinds[0] } : {}), id: "x" })) as Row;
      expect(outside, name).toMatchObject({ ok: false, tool: name, code: "bad-input" });
    }
    // The schema check and the folded check answered most wrong values; the bodies answered the
    // rest, with an ok or a refusal of their own (both kinds are in the run).
    expect(codes.get("bad-input") ?? 0).toBeGreaterThan(0);
    expect(codes.get("ok") ?? 0).toBeGreaterThan(0);
    expect([...codes.keys()].filter((code) => !["ok", "bad-input", "builder-unknown"].includes(code)).length).toBeGreaterThan(3);
    // An argument only the other kind reads, and an action the kind does not have.
    for (const input of [
      { action: "new", kind: "journey", from: "blank" },
      { action: "new", kind: "pdf_layout", shape: "sections" },
      { action: "move", kind: "journey", id: "intake", toIndex: 0 },
      { action: "map_fields", kind: "journey" },
      { action: "preview_pdf", kind: "journey", id: "intake" }
    ]) {
      const result = (await builder.registrar.execute("documents", input)) as Row;
      expect(result, JSON.stringify(input)).toMatchObject({ ok: false, code: "bad-input" });
      expect(JSON.stringify(result.details), JSON.stringify(input)).toMatch(/kind '/);
    }
    expect((Object.prototype as Row).polluted).toBeUndefined();
    expect(((await builder.execute("describe_builder", {})) as Row).ok).toBe(true);
  });

  /**
   * The routing runs before the input caps, so a
   * long `builder` string (70 000 characters, under the 256 KB input cap) reaches the
   * unknown-handle refusal, which quotes the handle cut to 128 characters ending in "…" and so
   * answers under the 64 KB result cap. The per-property fuzz above gives `builder` the huge
   * string too.
   */
  it(" an unknown handle of 70 000 characters answers a refusal under the result cap, the handle cut to 128 characters", async () => {
    const builder = fullPage().page.builder;
    for (const name of ["describe_builder", "history", "try_it"]) {
      const result = (await builder.registrar.execute(name, { action: "read", builder: "x".repeat(70_000) })) as Row;
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toBe("builder-unknown");
      expect(result.message, name).toBe(`No builder on this page has the handle "${"x".repeat(125)}…".`);
      expect(jsonByteLength(result), name).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    }
  });

  /**
   * A fill path (agent/builder/try-fields.ts): refused for a string over 10 000
   * characters answers the per-item code `too-large` (and a failed data source `options-failed`),
   * neither in the per-item list `try_it` documents. Pinned with `it.fails` until the body
   * maps them or the list (and BUILDER_ITEM_CODES above) includes them; then make it `it`.
   */
  it.fails("a try_it fill refused per item for a too-long string carries a code from the per-item list", async () => {
    const builder = fullPage().page.builder;
    const result = (await builder.execute("try_it", { action: "fill", answers: { full_name: "x".repeat(10_001) } })) as Row;
    const items = (result.refused ?? (result.details as Row | undefined)?.refused) as Row[] | undefined;
    expect(items?.length ?? 0).toBeGreaterThan(0);
    expectItemRefusals(result, "try_it fill too long");
  });

  it("a cyclic input resolves to an envelope for every tool (internal or a schema answer), never a rejection", async () => {
    // The registrar logs what its catch-all answers; keep the run's output quiet and count it.
    // Restored in `finally`, so a failing assertion does not leave console.error muted for the file.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const builder = fullPage().page.builder;
    const codes = new Set<string>();
    try {
      for (const name of ALL_NAMES) {
        for (const input of cycles()) {
          const where = `${name} cycle`;
          const settled = await builder.registrar.execute(name, input).then(
            (result) => ({ result: result as Row, error: undefined }),
            (error: unknown) => ({ result: undefined, error })
          );
          expect(settled.error, where).toBeUndefined();
          const result = settled.result as Row;
          expect(typeof result.ok, where).toBe("boolean");
          expect(result.tool, where).toBe(name);
          expectItemRefusals(result, where);
          if (result.ok === false) {
            expectRefusalShape(result, where);
            codes.add(result.code as string);
          }
          expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
        }
      }
    } finally {
      logged.mockRestore();
    }
    // A cycle the schema keeps (an open object such as a spec's children) is the catch-all's.
    expect(codes.has("internal")).toBe(true);
    const described = (await builder.execute("describe_builder", {})) as Row;
    expect(described.ok).toBe(true);
  });
});
