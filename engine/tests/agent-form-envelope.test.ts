import { describe, expect, it, vi } from "vitest";

import { FORM_AGENT_TOOL_NAMES, createFormAgentTools } from "../form-engine/agent/form/tools.js";
import { RESULT_BYTE_LIMIT, jsonByteLength } from "../form-engine/agent/result-caps.js";
import { SESSION_TOOL_NAMES } from "../form-engine/agent/session-tools.js";
import { SHARED_REFUSAL_CODES } from "../form-engine/agent/tool-types.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import {
  AGENT_JOURNEY_FORM,
  AGENT_SINGLE_FORM,
  AGENT_STEPS_FORM,
  TRAVEL_CLAIM_FORM,
  TRAVEL_CLAIM_LAYOUTS,
  agentSetup,
  bigForm,
  pdfDownloadResult,
  personTypes,
  type AgentSetup
} from "./fixtures/agent-form.js";

/**
 * The envelope every renderer result carries:
 * `tool`, `form` and `revision` on every result, JSON round-trip
 * equality for every tool and every action of `drafts` over the fixtures, a fuzz set (wrong
 * types, nulls, huge strings, cycles, prototype keys, an action outside the enum) no tool rejects
 * or throws for, every refusal's code from the closed tables, and the output caps.
 *
 * The round trip compares with `toStrictEqual`, not `toEqual`: the envelope bans `undefined`
 * members and non-plain values in a result, and only the strict matcher catches either one.
 */

type Row = Record<string, unknown>;

/**
 * The codes a renderer refusal may carry: the shared refusal codes, the renderer's closed
 * table and its additions. A code outside this set is a contract
 * break, whatever it says.
 */
const FORM_CODES: ReadonlySet<string> = new Set([
  ...SHARED_REFUSAL_CODES,
  // the renderer's closed table
  "unknown-field",
  "not-a-table",
  "no-options",
  "not-writable",
  "invalid-value",
  "no-such-option",
  "option-ambiguous",
  "options-loading",
  "options-failed",
  "no-such-row",
  "rows-locked",
  "rows-limit",
  "field-in-use",
  "person-data",
  "nothing-written",
  "locale-unsupported",
  "unknown-page",
  "unreachable",
  "blocked",
  "at-end",
  "at-start",
  "exit-page",
  "not-at-end",
  "signature-required",
  "already-submitted",
  "rejected",
  "nothing-to-undo",
  "submitted",
  // the renderer's additions
  "agent-off",
  "no-drafts",
  "no-draft",
  "answers-present",
  "draft-incompatible",
  "draft-failed",
  "draft-restored",
  "no-pdf",
  "unknown-layout",
  "pdf-blocked",
  "pdf-failed",
  "already-downloaded"
]);

/**
 * The codes a per-path refusal may carry: contract-renderer's `RefusedWrite.code` list, for
 * set_answers' `refused` (and `details.refused` on `nothing-written`) and edit_rows'
 * `refusedValues`. A tool missing here that hands back a per-item list fails the check.
 */
const REFUSED_WRITE_CODES: ReadonlySet<string> = new Set([
  "unknown-field",
  "not-writable",
  "invalid-value",
  "no-such-option",
  "option-ambiguous",
  "options-loading",
  "options-failed",
  "no-such-row",
  "rows-locked",
  "rows-limit",
  "field-in-use",
  "too-large",
  "feature-off",
  "bad-input"
]);
const FORM_ITEM_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  set_answers: REFUSED_WRITE_CODES,
  edit_rows: REFUSED_WRITE_CODES
};

/**
 * Every per-item refusal of a result (ok or not) is typed and carries a code from its tool's
 * per-item table. The envelope's own code is `expectRefusalShape`'s; this walks the items under it.
 */
function expectItemRefusals(result: Row, where: string): void {
  const details = result.details !== null && typeof result.details === "object" ? (result.details as Row) : undefined;
  for (const list of [result.refused, result.refusedValues, details?.refused]) {
    if (list === undefined) {
      continue;
    }
    expect(Array.isArray(list), `${where}: a per-item refusal list`).toBe(true);
    const allowed = FORM_ITEM_CODES[result.tool as string];
    expect(allowed, `${where}: ${String(result.tool)} has no per-item refusal table`).toBeDefined();
    for (const item of list as Row[]) {
      expect(typeof item.code, where).toBe("string");
      expect(typeof item.message, where).toBe("string");
      expect(typeof item.hint, where).toBe("string");
      expect(allowed?.has(item.code as string), `${where}: per-item code ${String(item.code)}`).toBe(true);
    }
  }
}

/** A refusal's envelope fields are all there and typed, and its code is one of the closed tables. */
function expectRefusalShape(result: Row, where: string): void {
  expect(typeof result.code, where).toBe("string");
  expect(typeof result.message, where).toBe("string");
  expect(typeof result.hint, where).toBe("string");
  expect(typeof result.retryable, where).toBe("boolean");
  expect(FORM_CODES.has(result.code as string), `${where}: code ${String(result.code)}`).toBe(true);
}

/** Every name a form page answers: the catalogue's and the session pair. */
const ALL_NAMES: readonly string[] = [...FORM_AGENT_TOOL_NAMES, ...SESSION_TOOL_NAMES];

/** The travel claim with a draft store and the PDF seam: drafts and download_pdf reach their bodies. */
function claimSetup(): AgentSetup {
  return agentSetup(TRAVEL_CLAIM_FORM, {
    drafts: { store: new InMemoryDraftStore() },
    host: { pdf: { layouts: TRAVEL_CLAIM_LAYOUTS, signed: false, download: () => Promise.resolve(pdfDownloadResult()) } }
  });
}

/** Each renderer tool's schema: its property names and, for an action-folded tool, the action's values. */
function schemas(): Map<string, { properties: string[]; actions?: string[] }> {
  const out = new Map<string, { properties: string[]; actions?: string[] }>();
  for (const tool of createFormAgentTools(claimSetup().host).tools) {
    const properties = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
    const actions = properties.action?.enum;
    out.set(tool.name, { properties: Object.keys(properties), ...(actions !== undefined ? { actions: [...actions] } : {}) });
  }
  return out;
}

const FUZZ: unknown[] = [
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
  { answers: null },
  { answers: [] },
  { answers: "x" },
  { answers: { name: { deep: { deeper: [1, 2, { deepest: true }] } } } },
  { answers: { name: "x".repeat(1_000_000) } },
  { field: 42 },
  { field: ["a"] },
  { collection: {}, action: "add" },
  { collection: "grid", action: "sideways" },
  { collection: "grid", action: "add", count: 0 },
  { collection: "grid", action: "add", count: 51 },
  { to: 5 },
  { to: "next", reveal: {} },
  { locale: "" },
  { locale: 123 },
  { scope: "everything" },
  { scope: "all", paths: "name" },
  { scope: "all", paths: [1, null] },
  { offset: -1 },
  { limit: 0 },
  { limit: 501 },
  { expectedRevision: 0 },
  { expectedRevision: "1" },
  { form: 7 },
  { form: "ghost" },
  { purpose: "x".repeat(5_000) },
  { summary: 12 },
  { undo: "yes", summary: "ok" },
  // Drafts' actions, download_pdf's arguments, an action outside the enum.
  { action: "sideways" },
  { action: 7 },
  { action: "restore", replaceAnswers: "yes" },
  { action: "save", replaceAnswers: true },
  { action: "clear", expectedRevision: 0 },
  { layoutId: 5 },
  { layoutId: "" },
  { layoutId: "ghost" },
  { layoutId: "x".repeat(1_000_000) },
  { layoutId: "receipt", locale: "zz" },
  { again: "yes" },
  { again: true, layoutId: "__proto__" },
  { layoutId: "constructor" },
  // Prototype keys, own and nested (JSON.parse makes `__proto__` an own key, as a page's caller could).
  JSON.parse('{"__proto__": {"polluted": true}}') as unknown,
  JSON.parse('{"answers": {"__proto__": {"polluted": true}}}') as unknown,
  JSON.parse('{"answers": {"name": {"__proto__": {"polluted": true}}}}') as unknown,
  JSON.parse('{"action": "restore", "__proto__": {"polluted": true}}') as unknown,
  { answers: { __proto__: "x", constructor: "y" } },
  { field: "__proto__" },
  { collection: "constructor", action: "add" }
];

/** Wrong values the schema-driven fuzz gives each property of each tool in turn. */
const WRONG_VALUES: readonly unknown[] = [null, 7, -1, 1.5, "", "ghost", true, [], [null], {}, { deep: { deeper: [1] } }, "x".repeat(70_000)];

/**
 * Inputs JSON cannot hold: an in-page caller can hand `execute()` a cycle. The registrar answers
 * one it cannot serialise as `internal` and drops one under an unknown
 * top-level key; either way the call resolves to an envelope.
 */
function cycles(): unknown[] {
  const top: Row = { field: "name" };
  top.self = top;
  const value: Row = { deep: true };
  value.again = value;
  const list: unknown[] = [];
  list.push(list);
  return [top, { answers: value }, { answers: { name: value } }, { collection: "grid", action: "add", values: value }, { paths: list }, { action: "save", extra: top }, { purpose: "Cycle", extra: top }];
}

describe("envelope", () => {
  it("every result carries tool, form and revision, and survives a JSON round trip, for every tool over the fixtures", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { name: "Ada", "grid[0].amount": 3 });
    // Each row names the outcome it gets ("ok" or the refusal's code), as the builder's round trip
    // does: a regression that turns a success into a refusal would otherwise swap the success
    // payload for a small refusal and silently drop it from the strict round trip. A single-page
    // form has no next page (navigate { to: "next" } is bad-input), and the required fields left
    // empty make both submits rejected.
    const calls: Array<[string, unknown, string, "items"?]> = [
      ["describe_form", {}, "ok"],
      ["describe_form", { scope: "all", detail: "outline" }, "ok"],
      ["get_answers", { includeEmpty: true, scope: "all" }, "ok"],
      ["get_options", { field: "colour" }, "ok"],
      ["check", {}, "ok"],
      ["set_answers", { answers: { colour: "Blue", age: 42, start: "2026-01-01", has_other: true, grid: [{ amount: 1 }] } }, "ok"],
      ["set_answers", { answers: { colour: "Nope" } }, "nothing-written"],
      ["edit_rows", { collection: "grid", action: "add", values: { amount: 4 } }, "ok"],
      ["edit_rows", { collection: "grid", action: "remove", index: 1 }, "ok"],
      // Ok results that carry per-item refusals, so the item walk runs over real items on a success
      // (the rows above only produce them on nothing-written): an added row with one cell outside
      // the options and one unknown column, and a partial set_answers.
      ["edit_rows", { collection: "grid", action: "add", values: { category: "Nope", ghost: 1, amount: 2 } }, "ok", "items"],
      ["set_answers", { answers: { name: "Ada", colour: "Nope" } }, "ok", "items"],
      ["navigate", { reveal: "tabbed" }, "ok"],
      ["navigate", { to: "next" }, "bad-input"],
      ["set_locale", { locale: "fr" }, "ok"],
      ["set_locale", { locale: "fr" }, "ok"],
      ["undo_agent_changes", { scope: "last" }, "ok"],
      ["begin_session", { purpose: "Round trip" }, "ok"],
      ["end_session", { summary: "Done", undo: true }, "ok"],
      ["submit", {}, "rejected"],
      ["submit", {}, "rejected"]
    ];
    const seen = new Set<string>();
    const actions = new Set<string>();
    const run = async (on: AgentSetup, name: string, input: unknown, outcome: string, items?: "items"): Promise<void> => {
      const where = `${name} ${JSON.stringify(input)}`;
      const result = (await on.execute(name, input)) as Row;
      seen.add(name);
      expect(result.tool, where).toBe(name);
      expectItemRefusals(result, where);
      expect(result.form, where).toBe("form-1");
      expect(typeof result.revision, where).toBe("number");
      expect(result.ok === true ? "ok" : result.code, `${where}: ${String(result.message)}`).toBe(outcome);
      if (result.ok === false) {
        expectRefusalShape(result, where);
        expect(result.code, where).not.toBe("internal");
      }
      if (items !== undefined) {
        // The row is there to feed the item walk: an empty list would let it pass without a check.
        const list = (result.refused ?? result.refusedValues) as unknown[] | undefined;
        expect(Array.isArray(list) && list.length > 0, `${where}: per-item refusals on an ok result`).toBe(true);
      }
      if (result.ok === true && typeof (input as Row).action === "string") {
        actions.add(`${name}:${(input as Row).action as string}`);
      }
      expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
      expect(jsonByteLength(result), where).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    };
    for (const [name, input, outcome, items] of calls) {
      await run(setup, name, input, outcome, items);
    }
    // The travel claim: every action of drafts and download_pdf over the draft
    // store and the PDF seam, each row with its pinned outcome.
    const claim = claimSetup();
    personTypes(claim.runtime, { traveller: "Ana", amount: 120 });
    for (const [name, input, outcome] of [
      ["describe_form", {}, "ok"],
      ["begin_session", { purpose: "Claim" }, "ok"],
      ["drafts", { action: "restore", replaceAnswers: true }, "no-draft"],
      ["drafts", { action: "save" }, "ok"],
      ["set_answers", { answers: { trip_start: "2026-10-01" } }, "ok"],
      ["drafts", { action: "restore" }, "answers-present"],
      ["drafts", { action: "restore", replaceAnswers: true }, "ok"],
      ["undo_agent_changes", { scope: "last" }, "draft-restored"],
      ["download_pdf", {}, "ok"],
      ["download_pdf", {}, "already-downloaded"],
      ["download_pdf", { layoutId: "receipt" }, "ok"],
      ["download_pdf", { layoutId: "ghost" }, "unknown-layout"],
      ["drafts", { action: "clear" }, "ok"],
      ["end_session", { summary: "Done" }, "ok"],
      ["submit", {}, "ok"]
    ] as Array<[string, unknown, string]>) {
      await run(claim, name, input, outcome);
    }
    for (const name of ALL_NAMES) {
      expect(seen.has(name), name).toBe(true);
    }
    // Every action of every action-folded renderer tool answered ok once, read from the schemas
    // (edit_rows' add and remove, drafts' save, restore and clear), so a new action fails here.
    const folded = [...schemas()].filter(([, schema]) => schema.actions !== undefined);
    expect(folded.map(([name]) => name).sort()).toEqual(["drafts", "edit_rows"]);
    for (const [name, schema] of folded) {
      for (const action of schema.actions ?? []) {
        expect(actions.has(`${name}:${action}`), `${name} ${action}`).toBe(true);
      }
    }
    // The journey and steps fixtures too, once each tool that reads them, each row with its pinned
    // outcome: the empty first page blocks the move on both; the journey's Submit is not on its
    // last page, the steps form's is rejected for the empty required fields.
    for (const [definition, navigated, submitted] of [
      [AGENT_JOURNEY_FORM, "blocked", "not-at-end"],
      [AGENT_STEPS_FORM, "blocked", "rejected"]
    ] as const) {
      const other = agentSetup(definition);
      for (const [name, input, outcome] of [
        ["describe_form", { scope: "all" }, "ok"],
        ["get_answers", { includeEmpty: true }, "ok"],
        ["check", { scope: "form" }, "ok"],
        ["navigate", { to: "next" }, navigated],
        ["submit", {}, submitted]
      ] as Array<[string, unknown, string]>) {
        await run(other, name, input, outcome);
      }
    }
  });

  it("no tool rejects or throws for the fuzz set, on the plain form and on the travel claim with drafts and PDFs; every answer is an envelope that round-trips", { timeout: 120_000 }, async () => {
    for (const [label, setup] of [
      ["single", agentSetup(AGENT_SINGLE_FORM)],
      ["travel claim", claimSetup()]
    ] as const) {
      for (const name of ALL_NAMES) {
        for (const input of FUZZ) {
          const where = `${label}: ${name} ${JSON.stringify(input)?.slice(0, 120)}`;
          // The registrar itself, not the fixture's `execute`, whose `input = {}` default would
          // turn the omitted-input (`undefined`) case into a second `{}`.
          const result = (await setup.registrar.execute(name, input)) as Row;
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
      // The form still works afterwards.
      const described = (await setup.execute("describe_form", {})) as Row;
      expect(described.ok, label).toBe(true);
    }
  });

  it("every action of drafts and every other tool, each property given each wrong value in turn, answers an envelope; an action outside the enum is bad-input", { timeout: 300_000 }, async () => {
    const setup = claimSetup();
    personTypes(setup.runtime, { traveller: "Ana", amount: 120 });
    const outcomes = new Map<string, number>();
    for (const [name, schema] of schemas()) {
      for (const action of schema.actions ?? [undefined]) {
        const base: Row = action !== undefined ? { action } : {};
        const inputs: Row[] = [base];
        for (const key of schema.properties) {
          if (key === "action") {
            continue;
          }
          for (const value of WRONG_VALUES) {
            inputs.push({ ...base, [key]: value });
          }
        }
        for (const input of inputs) {
          const where = `${name} ${JSON.stringify(input).slice(0, 160)}`;
          const result = (await setup.registrar.execute(name, input)) as Row;
          const outcome = result.ok === true ? "ok" : (result.code as string);
          outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
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
      if (schema.actions !== undefined) {
        const outside = (await setup.registrar.execute(name, { action: "sideways", collection: "items" })) as Row;
        expect(outside, name).toMatchObject({ ok: false, tool: name, code: "bad-input" });
      }
    }
    expect(outcomes.get("bad-input") ?? 0).toBeGreaterThan(0);
    expect(outcomes.get("ok") ?? 0).toBeGreaterThan(0);
    expect((Object.prototype as Row).polluted).toBeUndefined();
    expect(((await setup.execute("describe_form", {})) as Row).ok).toBe(true);
  });

  /**
   * Get_answers copies a table's rows as JSON, as
   * describe_form does, so a row the person filled only in part carries its other cells as `null`
   * (`{ amount: 3, category: null, when: null }`), never as `undefined` members, which the envelope
   * bans and JSON drops. The round trip above holds get_answers to the strict matcher too.
   */
  it(" get_answers carries no undefined member for a table row's empty cells", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { "grid[0].amount": 3 });
    const result = (await setup.execute("get_answers", { includeEmpty: true, scope: "all" })) as Row;
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });

  /**
   * The routing runs before the input caps, so a
   * long `form` string (70 000 characters, under the 256 KB input cap) reaches the unknown-handle
   * refusal, which quotes the handle cut to 128 characters ending in "…" and so answers under the
   * 64 KB result cap. The per-property fuzz above gives `form` the huge string too.
   */
  it(" an unknown handle of 70 000 characters answers a refusal under the result cap, the handle cut to 128 characters", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    for (const name of ["describe_form", "drafts", "set_answers"]) {
      const result = (await setup.registrar.execute(name, { action: "save", form: "x".repeat(70_000) })) as Row;
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toBe("form-unknown");
      expect(result.message, name).toBe(`No form on this page has the handle "${"x".repeat(125)}…".`);
      expect(jsonByteLength(result), name).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    }
  });

  it("a cyclic input resolves to an envelope for every tool (internal or a schema answer), never a rejection", async () => {
    // The registrar logs what its catch-all answers; keep the run's output quiet. Restored in
    // `finally`, so a failing assertion does not leave console.error muted for the file.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setup = claimSetup();
    try {
      for (const name of ALL_NAMES) {
        for (const input of cycles()) {
          const where = `${name} cycle`;
          const settled = await setup.registrar.execute(name, input).then(
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
          }
          expect(JSON.parse(JSON.stringify(result)), where).toStrictEqual(result);
        }
      }
    } finally {
      logged.mockRestore();
    }
    expect(((await setup.execute("describe_form", {})) as Row).ok).toBe(true);
  });

  it("the 1 000-field form: describe_form stays under 64 KB, pages with truncated / nextOffset, and a walk covers every field", async () => {
    const setup = agentSetup(bigForm(1_000));
    const first = (await setup.execute("describe_form", {})) as Row;
    expect(first.ok).toBe(true);
    expect(jsonByteLength(first)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
    expect(first.fieldCount).toBe(1_000);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(100);
    const ids = new Set<string>();
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = (await setup.execute("describe_form", { offset, limit: 100, detail: "outline" })) as Row;
      expect(result.ok).toBe(true);
      expect(jsonByteLength(result)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
      for (const field of result.fields as Row[]) {
        ids.add(field.id as string);
      }
      if (result.truncated !== true) {
        break;
      }
      offset = result.nextOffset as number;
    }
    expect(ids.size).toBe(1_000);
    // A whole page of full detail over the cap is cut by the registrar, never rejected.
    const wide = (await setup.execute("describe_form", { limit: 500 })) as Row;
    expect(typeof wide.ok).toBe("boolean");
    expect(jsonByteLength(wide)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  });

  it("a 2 500-character value is cut with valueTruncated in describe_form and get_answers", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    personTypes(setup.runtime, { name: "n".repeat(2_500) });
    const described = (await setup.execute("describe_form", {})) as Row;
    const name = (described.fields as Row[]).find((field) => field.path === "name");
    expect(name?.valueTruncated).toBe(true);
    expect((name?.value as string).length).toBeLessThanOrEqual(2_000);
    const answers = (await setup.execute("get_answers", {})) as Row;
    const answer = (answers.answers as Row[]).find((entry) => entry.path === "name");
    expect(answer?.valueTruncated).toBe(true);
    expect((answer?.value as string).length).toBeLessThanOrEqual(2_000);
  });

  it("a stray argument is named in warnings and the ok result keeps the tool's own warnings beside it", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = (await setup.execute("describe_form", { scope: "visible", bogus: true })) as Row;
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["ignored unknown argument: bogus"]);
  });
});
