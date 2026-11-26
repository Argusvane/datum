import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { createFormAgentTools } from "../form-engine/agent/form/tools.js";
import { runtimeAgentHost } from "../form-engine/agent/form/host.js";
import { createAgentRegistrar } from "../form-engine/agent/registrar.js";
import { AGENT_JOURNEY_FORM, AGENT_SINGLE_FORM, AGENT_STEPS_FORM, agentRuntime, agentSetup, countEvents, personTypes } from "./fixtures/agent-form.js";

/**
 * The renderer catalogue's write tools: set_answers and
 * edit_rows, every per-path refusal with its exact hint, the fold's answers, the rule that a write
 * never moves the person and the count of one dry run per write call.
 */

type Row = Record<string, unknown>;

function refusedOf(result: Record<string, unknown>, path: string): Row {
  const entry = (result.refused as Row[]).find((item) => item.path === path);
  if (entry === undefined) {
    throw new Error(`no refusal for ${path}: ${JSON.stringify(result.refused)}`);
  }
  return entry;
}

function writtenPaths(result: Record<string, unknown>): string[] {
  return (result.written as Row[]).map((item) => item.path as string);
}

/** The single form with its grid's configuration replaced. */
function gridVariant(configuration: Record<string, unknown>, children?: ComponentNode[]): FormDefinition {
  const content = (AGENT_SINGLE_FORM.root.children as { content: ComponentNode[] }).content.map((node) =>
    node.id === "grid" ? { ...node, configuration: { label: "Expenses", ...configuration }, ...(children !== undefined ? { children: { content: children } } : {}) } : node
  );
  return { ...AGENT_SINGLE_FORM, root: { ...AGENT_SINGLE_FORM.root, children: { content } } };
}

/** A repeating section whose row template holds another repeating section (drawn as a plain group). */
const NESTED_FORM: FormDefinition = {
  ...AGENT_SINGLE_FORM,
  id: "nested",
  root: {
    id: "form",
    type: "form",
    configuration: { label: "Nested" },
    children: {
      content: [
        {
          id: "orders",
          type: "repeatingSection",
          configuration: { label: "Orders" },
          collection: { itemFields: ["ref"] },
          children: {
            content: [
              { id: "ref", type: "text", configuration: { label: "Reference" } },
              {
                id: "lines",
                type: "repeatingSection",
                configuration: { label: "Lines" },
                collection: { itemFields: ["sku"] },
                children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
              }
            ]
          }
        }
      ]
    }
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe("set_answers: coercion and per-path refusals", () => {
  it("writes every kind in one call: text, a locale numeral, a date, a boolean word, a label-matched choice, a multichoice array, a whole table", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    setup.events.length = 0;
    const result = await setup.ok("set_answers", {
      answers: { name: "Ada", age: "1,000", start: "2026-02-03", has_other: "yes", colour: "Blue", topics: ["News", "offers"], grid: [{ when: "2026-01-01", amount: "5", category: "Meal" }] }
    });
    expect(writtenPaths(result)).toEqual(["name", "age", "start", "has_other", "colour", "topics", "grid"]);
    const written = result.written as Row[];
    expect(written[1]).toMatchObject({ value: 1000, previous: null, display: "1,000", coerced: true });
    expect(written[2]).toMatchObject({ value: "2026-02-03", display: "February 3, 2026" });
    expect(written[3]).toMatchObject({ value: true, display: "Yes", coerced: true });
    expect(written[4]).toMatchObject({ value: "blue", display: "Blue", matched: "label" });
    expect(written[5]).toMatchObject({ value: { news: true, offers: true }, display: "News, Offers", matched: "label" });
    expect(written[6]).toMatchObject({ value: [{ when: "2026-01-01", amount: 5, category: "meal" }], display: "1 row", rows: { replaced: 1 } });
    expect(result.refused).toEqual([]);
    expect(result.undoable).toBe(true);
    expect(result.page).toEqual({ id: "form", title: "Agent single", changed: false });
    expect(setup.runtime.formValues()).toMatchObject({ name: "Ada", age: 1000, topics: { news: true, offers: true }, "grid[0].amount": 5, "grid[0].category": "meal" });
    // One recompute for the write, one for the dry run, no more.
    expect(countEvents(setup.events, FormEventType.RECOMPUTE_COMPLETED)).toBe(2);
    // Painted, then reveal of the written components, then the announcement.
    const methods = setup.host.calls.map((call) => call.method).filter((method) => method !== "emit");
    expect(methods).toEqual(["reveal", "announce", "scrollTo"]);
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["An assistant filled 7 fields"]);
  });

  it("a number from a French numeral after set_locale, and the dry-run errors worded in French", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    await setup.ok("set_locale", { locale: "fr" });
    const result = await setup.ok("set_answers", { answers: { age: "1 000,5", name: "Ada" } });
    expect((result.written as Row[])[0]).toMatchObject({ value: 1000.5, coerced: true, display: new Intl.NumberFormat("fr").format(1000.5) });
    const low = await setup.ok("set_answers", { answers: { age: 5 } });
    const errors = low.errors as Row[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "age", id: "age", label: "Age", code: "number.min", severity: "error", source: "client" });
    expect(errors[0]?.message).toMatch(/18/u);
    expect(errors[0]?.message).not.toMatch(/at least/u);
  });

  it("refuses an unknown path with suggestions and the exact hint, a bad path as bad-input, and keeps writing the rest", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.ok("set_answers", { answers: { nmae: "Ada", "bad path!": 1, age: 30 } });
    expect(writtenPaths(result)).toEqual(["age"]);
    expect(refusedOf(result, "nmae")).toEqual({
      path: "nmae",
      code: "unknown-field",
      message: "No field has the path or id 'nmae'.",
      hint: "Use a `path` from describe_form; did you mean name, age?",
      details: { ref: "nmae", suggestions: ["name", "age"] }
    });
    expect(refusedOf(result, "bad path!")).toMatchObject({ code: "bad-input", details: { problems: [{ key: "answers.bad path!" }] } });
  });

  it("refuses not-writable per reason with the exact hints: hidden, disabled, readonly, calculated, group, file, static, presentation", async () => {
    const single = agentSetup(AGENT_SINGLE_FORM);
    const result = await single.ok("set_answers", { answers: { other: "x", double: 3, dates: "x", receipt: "a.pdf", blurb: "x", send: "x", name: "ok" } });
    expect(writtenPaths(result)).toEqual(["name"]);
    expect(refusedOf(result, "other")).toMatchObject({
      code: "not-writable",
      details: { path: "other", reason: "hidden" },
      hint: "The form hides this field right now; another answer may reveal it (describe_form scope 'all' shows the hidden ones)."
    });
    expect(refusedOf(result, "double")).toMatchObject({ code: "not-writable", details: { reason: "calculated" }, hint: "The form works this value out itself; write the fields it depends on." });
    expect(refusedOf(result, "dates")).toMatchObject({ code: "not-writable", details: { reason: "group" }, hint: "This is a container; write its fields' paths instead." });
    expect(refusedOf(result, "receipt")).toMatchObject({
      code: "not-writable",
      details: { reason: "unfillable", unfillableKind: "file" },
      hint: "Files, signatures, buttons and nested tables must be handled by the person; ask them."
    });
    expect(refusedOf(result, "blurb")).toMatchObject({ code: "not-writable", details: { reason: "unfillable", unfillableKind: "static" } });
    expect(refusedOf(result, "send")).toMatchObject({ code: "not-writable", details: { reason: "unfillable", unfillableKind: "button" } });

    const journey = agentSetup(AGENT_JOURNEY_FORM);
    const disabled = await journey.ok("set_answers", { answers: { nickname: "n", applicant_name: "Locked" } });
    expect(refusedOf(disabled, "nickname")).toMatchObject({ code: "not-writable", details: { reason: "disabled" }, hint: "The form does not allow changing this field; tell the person." });
    await journey.ok("set_answers", { answers: { wants_details: true } });
    const readonly = await journey.refused("set_answers", { answers: { nickname: "n" } });
    expect(readonly.code).toBe("nothing-written");
    expect((readonly.details?.refused as Row[])[0]).toMatchObject({ code: "not-writable", details: { reason: "readonly" } });
    expect(readonly.hint).toBe("See each refusal's hint.");
  });

  it("refuses invalid values per kind with `expected` filled into the hint", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.refused("set_answers", {
      answers: { age: "abc", start: "4 Oct 2026", has_other: "maybe", name: { nested: true }, topics: 5, grid: "x" }
    });
    expect(result.code).toBe("nothing-written");
    const refused = result.details?.refused as Row[];
    const byPath = Object.fromEntries(refused.map((entry) => [entry.path, entry]));
    expect(byPath.age).toMatchObject({ code: "invalid-value", hint: "Pass a number for `age`.", details: { path: "age", kind: "number", expected: "a number", got: "abc" } });
    expect(byPath.start).toEqual({
      path: "start",
      code: "invalid-value",
      message: "'4 Oct 2026' is not a date in the form YYYY-MM-DD.",
      hint: "Pass a date as YYYY-MM-DD for `start`.",
      details: { path: "start", kind: "date", expected: "a date as YYYY-MM-DD", got: "4 Oct 2026" }
    });
    expect(byPath.has_other).toMatchObject({ hint: "Pass true or false for `has_other`." });
    expect(byPath.name).toMatchObject({ hint: "Pass a string for `name`.", details: { got: "an object" } });
    expect(byPath.topics).toMatchObject({ hint: "Pass an array of option values for `topics`." });
    expect(byPath.grid).toMatchObject({ hint: "Pass an array of row objects for `grid`." });
    expect(setup.runtime.formValues().age).toBeUndefined();
  });

  it("refuses an unknown option and an ambiguous label, each with its exact hint; a free-text source accepts anything", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.refused("set_answers", { answers: { colour: "Purple", topics: ["Green"] } });
    const refused = result.details?.refused as Row[];
    expect(refused[0]).toMatchObject({
      path: "colour",
      code: "no-such-option",
      hint: "Pick one of the listed option values, or call get_options with a `query` to search all 4.",
      details: { path: "colour", got: "Purple", total: 4, acceptsFreeText: false }
    });
    expect((refused[0]?.details as Row).options).toHaveLength(4);
    expect(refused[1]).toMatchObject({ path: "topics", code: "no-such-option" });
    const ambiguous = await setup.refused("set_answers", { answers: { colour: "Green" } });
    expect((ambiguous.details?.refused as Row[])[0]).toMatchObject({
      code: "option-ambiguous",
      hint: "Send the option's `value` instead of its label.",
      details: { path: "colour", got: "Green", candidates: [{ value: "g1", label: "Green" }, { value: "g2", label: "Green" }] }
    });
    const nfc = await setup.ok("set_answers", { answers: { colour: " Blue " } });
    expect((nfc.written as Row[])[0]).toMatchObject({ value: "blue", matched: "label" });

    const free: FormDefinition = {
      ...AGENT_JOURNEY_FORM,
      root: {
        ...AGENT_JOURNEY_FORM.root,
        children: {
          content: (AGENT_JOURNEY_FORM.root.children as { content: ComponentNode[] }).content.map((node) =>
            node.id === "province" ? { ...node, configuration: { label: "Province", data: { sourceId: "provinces", answersFree: true } } } : node
          )
        }
      }
    };
    const freeSetup = agentSetup(free);
    const written = await freeSetup.ok("set_answers", { answers: { province: "Nunavut" } });
    expect((written.written as Row[])[0]).toMatchObject({ value: "Nunavut", matched: "free" });
  });

  it("refuses options-loading while a source is out and options-failed when it failed, never with the source's text", async () => {
    vi.useFakeTimers();
    const pending = agentSetup(AGENT_JOURNEY_FORM, { dataSources: defineDataSources({ provinces: () => new Promise(() => undefined) }) });
    const call = pending.refused("set_answers", { answers: { province: "ON" } });
    await vi.advanceTimersByTimeAsync(5_100);
    const loading = await call;
    expect((loading.details?.refused as Row[])[0]).toEqual({
      path: "province",
      code: "options-loading",
      message: "The choices of 'province' have not loaded yet, so the value cannot be checked.",
      hint: "Call get_options for this field, then retry.",
      details: { path: "province", sourceId: "provinces" }
    });
    vi.useRealTimers();
    const failed = agentSetup(AGENT_JOURNEY_FORM, {
      dataSources: defineDataSources({
        provinces: () => {
          throw new Error("backend secret");
        }
      })
    });
    const broken = await failed.refused("set_answers", { answers: { province: "ON" } });
    expect((broken.details?.refused as Row[])[0]).toMatchObject({
      code: "options-failed",
      hint: "The field's choices did not load; tell the person and leave the field.",
      details: { path: "province", sourceId: "provinces", what: "data-source" }
    });
    expect(JSON.stringify(broken)).not.toContain("backend secret");
  });

  it("refuses a row past the end without appending one, and feature-off for a source-backed field when data sources are left out", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const result = await setup.refused("set_answers", { answers: { "grid[3].amount": 4 } });
    expect((result.details?.refused as Row[])[0]).toEqual({
      path: "grid[3].amount",
      code: "no-such-row",
      message: "'grid' has 1 rows; there is no row 3.",
      hint: "The table has 1 rows; add one with edit_rows, or pass the whole table as an array to set_answers.",
      details: { collection: "grid", index: 3, rows: 1 }
    });
    expect(setup.runtime.rows("grid")).toHaveLength(1);
    const inRow = await setup.ok("set_answers", { answers: { "grid[0].amount": 4, amount: 9 } });
    expect(setup.runtime.formValues()["grid[0].amount"]).toBe(9);
    expect(writtenPaths(inRow)).toEqual(["grid[0].amount"]);

    const off = agentSetup(AGENT_JOURNEY_FORM, { host: { allows: { "data-sources": false } } });
    const refused = await off.refused("set_answers", { answers: { province: "ON" } });
    expect((refused.details?.refused as Row[])[0]).toMatchObject({ code: "feature-off", details: { feature: "data-sources" } });
  });

  it("replaces a table whole within its operations and bounds, refusing rows-locked and rows-limit otherwise", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const limit = await setup.refused("set_answers", { answers: { grid: [{}, {}, {}, {}] } });
    expect((limit.details?.refused as Row[])[0]).toEqual({
      path: "grid",
      code: "rows-limit",
      message: "'grid' would hold 4 rows, outside its bounds.",
      hint: "The table allows between 1 and 3 rows; it has 1.",
      details: { collection: "grid", min: 1, max: 3, rows: 1, asked: 4 }
    });
    const ok = await setup.ok("set_answers", { answers: { grid: [{ amount: 1 }, { amount: 2 }] } });
    expect((ok.written as Row[])[0]).toMatchObject({ rows: { replaced: 2 }, previous: [{ when: null, amount: null, category: null }] });
    expect(setup.runtime.rows("grid")).toHaveLength(2);

    const locked = agentSetup(gridVariant({ minRows: 0, maxRows: 5, canAdd: false }));
    const refused = await locked.refused("set_answers", { answers: { grid: [{ amount: 1 }, { amount: 2 }] } });
    expect((refused.details?.refused as Row[])[0]).toMatchObject({
      code: "rows-locked",
      hint: "Rows cannot be replaced here; tell the person.",
      details: { collection: "grid", operation: "replace" }
    });
    const cell = await setup.refused("set_answers", { answers: { "grid[0].amount": "x".repeat(10_001) } });
    expect((cell.details?.refused as Row[])[0]).toMatchObject({ code: "too-large", details: { what: "input", limit: 10_000, got: 10_001, key: "grid[0].amount" } });
  });

  it("reports revealed, nowRequired and nowHidden from the fold, and null clears a field", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const on = await setup.ok("set_answers", { answers: { has_other: true } });
    expect(on.revealed).toEqual([{ id: "other", path: "other", type: "text", kind: "text", label: "What else", required: false, visible: true, writable: true, hasRules: ["visibleWhen"] }]);
    expect(on.nowRequired).toEqual(["detail"]);
    expect(on.nowHidden).toEqual([]);
    const off = await setup.ok("set_answers", { answers: { has_other: null, other: null } });
    expect(off.nowHidden).toEqual(["other"]);
    expect(off.revealed).toEqual([]);
    expect(writtenPaths(off)).toEqual(["has_other", "other"]);
    expect(setup.runtime.formValues().has_other).toBeUndefined();
  });

  it("refuses the field the person is typing in outside a session (field-in-use) and writes it inside one", async () => {
    let focused: string | undefined = "name";
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { focusedValuePath: () => focused } });
    const result = await setup.ok("set_answers", { answers: { name: "Ada", age: 30 } });
    expect(writtenPaths(result)).toEqual(["age"]);
    expect(refusedOf(result, "name")).toEqual({
      path: "name",
      code: "field-in-use",
      message: "The person is typing in 'name' right now.",
      hint: "Write the other fields now and retry this one, or call begin_session to pause the person's typing first.",
      details: { path: "name" }
    });
    expect(setup.host.calls.some((call) => call.method === "scrollTo")).toBe(false);
    await setup.ok("begin_session", { purpose: "Filling" });
    const inSession = await setup.ok("set_answers", { answers: { name: "Ada" } });
    expect(writtenPaths(inSession)).toEqual(["name"]);
    focused = undefined;
  });

  it("writes a field on another step in place: the step stays, no navigation fires, the field is listed under elsewhere", async () => {
    const setup = agentSetup(AGENT_STEPS_FORM);
    const before = setup.runtime.state().navigation.currentStepId;
    setup.events.length = 0;
    const result = await setup.ok("set_answers", { answers: { city: "ott", name: "Ada" } });
    expect(writtenPaths(result)).toEqual(["city", "name"]);
    expect(result.elsewhere).toEqual([{ path: "city", id: "city", step: "step2" }]);
    expect(result.note).toEqual(["Some fields are on other pages or steps; they were written in place and their page checks run when you navigate there."]);
    expect(result.page).toEqual({ id: "step1", title: "About you", number: 1, total: 2, changed: false });
    expect(setup.runtime.state().navigation.currentStepId).toBe(before);
    expect(countEvents(setup.events, FormEventType.NAVIGATION_COMPLETED)).toBe(0);
    expect(setup.host.calls.find((call) => call.method === "reveal")?.args).toEqual([["name"]]);
  });

  it("writes a field on a later journey page in place: the page stays and no PAGE_CHANGED fires", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    setup.events.length = 0;
    const result = await setup.ok("set_answers", { answers: { email: "ada@example.org", applicant_name: "Ada" } });
    expect(result.elsewhere).toEqual([{ path: "email", id: "email", page: "contact" }]);
    expect(result.page).toEqual({ id: "intro", title: "Name", number: 1, total: 3, changed: false });
    expect(setup.runtime.journeyView()?.pageId).toBe("intro");
    expect(countEvents(setup.events, FormEventType.PAGE_CHANGED)).toBe(0);
    expect(setup.host.calls.find((call) => call.method === "reveal")?.args).toEqual([["applicant_name"]]);
  });

  it("stale carries the paths changed since with who changed them; alsoChanged names a foreign write", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const first = await setup.ok("set_answers", { answers: { age: 30 } });
    personTypes(setup.runtime, { name: "Typed" });
    const next = await setup.ok("set_answers", { answers: { age: 31 } });
    expect(next.alsoChanged).toEqual(["name"]);
    const again = await setup.ok("set_answers", { answers: { age: 32 } });
    expect(again.alsoChanged).toBeUndefined();
    personTypes(setup.runtime, { name: "Retyped" });
    const stale = await setup.refused("set_answers", { answers: { age: 33 }, expectedRevision: first.revision });
    expect(stale).toMatchObject({ code: "stale", retryable: false, hint: "Re-read the changed fields with get_answers, then call again with the new revision." });
    expect(((stale.details as Row).changedPaths as Row[]).map((entry) => [entry.path, entry.by])).toEqual([
      ["name", "other"],
      ["age", "agent"],
      ["age", "agent"],
      ["name", "other"]
    ]);
    expect(setup.runtime.formValues().age).toBe(32);
  });

  it("refuses nothing-written, too-large past 200 keys, and names a stray argument in warnings", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const none = await setup.refused("set_answers", { answers: { nope: 1 } });
    expect(none).toMatchObject({ code: "nothing-written", retryable: false, hint: "See each refusal's hint." });
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 201; index += 1) {
      many[`f${index}`] = index;
    }
    const big = await setup.refused("set_answers", { answers: many });
    expect(big).toMatchObject({ code: "too-large", details: { what: "input", limit: 200, got: 201, key: "answers" } });
    const stray = await setup.ok("set_answers", { answers: { age: 40 }, expectedRevison: 1 });
    expect(stray.warnings).toEqual(["ignored unknown argument: expectedRevison"]);
  });
});

describe("edit_rows", () => {
  it("adds rows with count, fills the first from values, reports rowPaths and refusedValues, and announces", async () => {
    const setup = agentSetup(gridVariant({ minRows: 0, maxRows: 10, initialRows: 0 }));
    const addRows = vi.spyOn(setup.runtime, "addRows");
    setup.events.length = 0;
    const result = await setup.ok("edit_rows", { collection: "grid", action: "add", count: 3, values: { amount: "abc", category: "Taxi", bogus: 1 } });
    expect(addRows).toHaveBeenCalledTimes(1);
    // One recompute for the rows added, one for the dry run.
    expect(countEvents(setup.events, FormEventType.RECOMPUTE_COMPLETED)).toBe(2);
    expect(result).toMatchObject({ collection: { path: "grid", id: "grid", label: "Expenses" }, action: "add", indexes: [0, 1, 2], undoable: true });
    expect(result.rows).toEqual({ count: 3, min: 0, max: 10, canAdd: true, canRemove: true });
    expect((result.rowPaths as Row[])[0]).toEqual({ when: "grid[0].when", amount: "grid[0].amount", category: "grid[0].category" });
    const refused = result.refusedValues as Row[];
    expect(refused.map((entry) => [entry.path, entry.code])).toEqual([
      ["grid[0].amount", "invalid-value"],
      ["grid[0].bogus", "unknown-field"]
    ]);
    expect(setup.runtime.rows("grid")[0]).toMatchObject({ category: "taxi" });
    expect(setup.runtime.rows("grid")[0]?.amount).toBeUndefined();
    expect(setup.host.calls.find((call) => call.method === "announce")?.args).toEqual(["An assistant added 3 rows to Expenses"]);
    expect(setup.host.calls.find((call) => call.method === "reveal")?.args).toEqual([["grid"]]);
    const one = await setup.ok("edit_rows", { collection: "grid", action: "add" });
    expect(one.indexes).toEqual([3]);
    expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["An assistant added 1 row to Expenses"]);
  });

  it("refuses rows-limit on add past max and on a remove below min (enforced in the layer), each with the exact hint", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const add = await setup.refused("edit_rows", { collection: "grid", action: "add", count: 3 });
    expect(add).toMatchObject({ code: "rows-limit", hint: "The table allows between 1 and 3 rows; it has 1.", details: { collection: "grid", min: 1, max: 3, rows: 1, asked: 4 } });
    const removeRow = vi.spyOn(setup.runtime, "removeRow");
    const remove = await setup.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(remove).toMatchObject({ code: "rows-limit", details: { rows: 1, asked: 0 } });
    expect(removeRow).not.toHaveBeenCalled();
    expect(setup.runtime.rows("grid")).toHaveLength(1);
  });

  it("refuses rows-locked when the table forbids the operation, no-such-row without touching the runtime, not-a-table on a field", async () => {
    const locked = agentSetup(gridVariant({ minRows: 0, maxRows: 5, canAdd: false, canRemove: false, initialRows: 1 }));
    const add = await locked.refused("edit_rows", { collection: "grid", action: "add" });
    expect(add).toMatchObject({ code: "rows-locked", hint: "Rows cannot be added here; tell the person.", details: { collection: "grid", operation: "add" } });
    const remove = await locked.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(remove).toMatchObject({ code: "rows-locked", hint: "Rows cannot be removed here; tell the person.", details: { operation: "remove" } });

    const setup = agentSetup(AGENT_SINGLE_FORM);
    const removeRow = vi.spyOn(setup.runtime, "removeRow");
    const missing = await setup.refused("edit_rows", { collection: "grid", action: "remove", index: 5 });
    expect(missing).toMatchObject({ code: "no-such-row", hint: "The table has 1 rows; add one with edit_rows, or pass the whole table as an array to set_answers.", details: { collection: "grid", index: 5, rows: 1 } });
    expect(removeRow).not.toHaveBeenCalled();
    const notTable = await setup.refused("edit_rows", { collection: "name", action: "add" });
    expect(notTable).toMatchObject({ code: "not-a-table", hint: "edit_rows takes a field of kind 'collection'; write this field with set_answers.", details: { path: "name", kind: "text" } });
    const unknown = await setup.refused("edit_rows", { collection: "gird", action: "add" });
    expect(unknown).toMatchObject({ code: "unknown-field", details: { suggestions: ["grid"] } });
    const badInput = await setup.refused("edit_rows", { collection: "grid", action: "remove" });
    expect(badInput).toMatchObject({ code: "bad-input", details: { problems: [{ key: "index", expected: "required for action 'remove'" }] } });
    const mixed = await setup.refused("edit_rows", { collection: "grid", action: "add", index: 0 });
    expect(mixed).toMatchObject({ code: "bad-input", details: { problems: [{ key: "index" }] } });
  });

  it("refuses person-data on a row the person typed in unless force is true, then removes it and keeps its values", async () => {
    const setup = agentSetup(gridVariant({ minRows: 0, maxRows: 5, initialRows: 1 }));
    personTypes(setup.runtime, { "grid[0].amount": 12 });
    const refused = await setup.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(refused).toEqual(
      expect.objectContaining({
        code: "person-data",
        message: "Row 0 of 'Expenses' holds entries the person typed.",
        hint: "Removing the person's own entries needs their say; ask them, then pass force: true.",
        details: { collection: "grid", index: 0, paths: ["grid[0].amount"] }
      })
    );
    const forced = await setup.ok("edit_rows", { collection: "grid", action: "remove", index: 0, force: true });
    expect(forced).toMatchObject({ action: "remove", indexes: [0], removed: { when: null, amount: 12, category: null }, rows: { count: 0 } });
    expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["An assistant removed a row from Expenses"]);
    // A row the agent itself filled is removed without force.
    await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 3 } });
    const own = await setup.ok("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(own.indexes).toEqual([0]);
  });

  it("refuses field-in-use while the person types in a cell of that table, and nested-rows for a table inside another's row", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM, { host: { focusedValuePath: () => "grid[0].amount" } });
    const busy = await setup.refused("edit_rows", { collection: "grid", action: "add" });
    expect(busy).toMatchObject({ code: "field-in-use", details: { path: "grid[0].amount" } });

    const nested = agentSetup(NESTED_FORM);
    await nested.ok("edit_rows", { collection: "orders", action: "add", values: { ref: "A" } });
    const inner = await nested.refused("edit_rows", { collection: "lines", action: "add" });
    expect(inner).toMatchObject({ code: "not-writable", details: { reason: "unfillable", unfillableKind: "nested-rows" } });
    const described = await nested.ok("describe_form");
    const lines = (described.fields as Row[]).find((field) => field.id === "lines");
    expect(lines).toMatchObject({ kind: "collection", writable: false, unfillableKind: "nested-rows" });
  });

  it("edits a table on another page in place and names the page under elsewhere", async () => {
    const setup = agentSetup(AGENT_JOURNEY_FORM);
    setup.events.length = 0;
    const result = await setup.ok("edit_rows", { collection: "items", action: "add", values: { qty: 2 } });
    expect(result.elsewhere).toEqual({ page: "review" });
    expect(result.indexes).toEqual([0]);
    expect(setup.runtime.journeyView()?.pageId).toBe("intro");
    expect(countEvents(setup.events, FormEventType.PAGE_CHANGED)).toBe(0);
    expect(setup.host.calls.some((call) => call.method === "reveal")).toBe(false);
    expect(setup.runtime.rows("items")).toEqual([{ qty: 2 }]);
  });
});

describe("the person's rows and caret survive the agent's table operations", () => {
  it("refuses a whole-table write with field-in-use while the person types in a cell of that table", async () => {
    const setup = agentSetup(gridVariant({ minRows: 0, maxRows: 5, initialRows: 1 }), { host: { focusedValuePath: () => "grid[0].amount" } });
    personTypes(setup.runtime, { "grid[0].amount": 12 });
    const result = await setup.ok("set_answers", { answers: { grid: [{ amount: 99 }], name: "Ada" } });
    expect(writtenPaths(result)).toEqual(["name"]);
    expect(refusedOf(result, "grid")).toMatchObject({ code: "field-in-use", message: "The person is typing in 'grid[0].amount' right now.", details: { path: "grid[0].amount" } });
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([12]);
    const alone = await setup.refused("set_answers", { answers: { grid: [{ amount: 99 }] } });
    expect(alone.code).toBe("nothing-written");
    expect(setup.runtime.rows("grid").map((row) => row.amount)).toEqual([12]);
  });

  it("refuses person-data after the person reshaped the table, after the agent's own forced remove, and for rows hydrated before the catalogue subscribed", async () => {
    // The person deletes a stray empty row: the table is theirs, the marks stay with the rows.
    const reshaped = agentSetup(gridVariant({ minRows: 0, maxRows: 5, initialRows: 0 }));
    reshaped.runtime.addRow("grid", {});
    reshaped.runtime.addRow("grid", {});
    personTypes(reshaped.runtime, { "grid[0].amount": 12 });
    reshaped.runtime.removeRow("grid", 1);
    const afterReshape = await reshaped.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(afterReshape).toMatchObject({ code: "person-data", details: { collection: "grid", index: 0, paths: ["grid[0].amount"] } });
    expect(reshaped.runtime.rows("grid").map((row) => row.amount)).toEqual([12]);

    // The agent's forced remove shifts the rows above it down by one: their marks follow.
    const shifted = agentSetup(gridVariant({ minRows: 0, maxRows: 5, initialRows: 0 }));
    shifted.runtime.addRow("grid", {});
    shifted.runtime.addRow("grid", {});
    personTypes(shifted.runtime, { "grid[0].amount": 1, "grid[1].amount": 2 });
    await shifted.ok("edit_rows", { collection: "grid", action: "remove", index: 0, force: true });
    expect(shifted.runtime.rows("grid").map((row) => row.amount)).toEqual([2]);
    const second = await shifted.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(second).toMatchObject({ code: "person-data", details: { index: 0, paths: ["grid[0].amount"] } });

    // The agent adds and removes its own row: the person's rows keep their marks.
    const own = agentSetup(gridVariant({ minRows: 0, maxRows: 5, initialRows: 0 }));
    personTypes(own.runtime, { "grid[0].amount": 10, "grid[1].amount": 20 });
    await own.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 3 } });
    await own.ok("edit_rows", { collection: "grid", action: "remove", index: 2 });
    const theirs = await own.refused("edit_rows", { collection: "grid", action: "remove", index: 0 });
    expect(theirs).toMatchObject({ code: "person-data", details: { paths: ["grid[0].amount"] } });
    expect(own.runtime.rows("grid").map((row) => row.amount)).toEqual([10, 20]);

    // A draft hydrated before any catalogue subscribed: a non-empty cell with no mark is the person's.
    const runtime = agentRuntime(gridVariant({ minRows: 0, maxRows: 5, initialRows: 0 }));
    personTypes(runtime, { "grid[0].amount": 7 });
    const host = runtimeAgentHost(runtime);
    const registrar = createAgentRegistrar();
    registrar.registerForm({ host, catalogue: createFormAgentTools, signal: new AbortController().signal });
    const draft = (await registrar.execute("edit_rows", { collection: "grid", action: "remove", index: 0 })) as Row;
    expect(draft).toMatchObject({ ok: false, code: "person-data", details: { paths: ["grid[0].amount"] } });
    expect(runtime.rows("grid").map((row) => row.amount)).toEqual([7]);
    // An empty prefilled row holds nothing of theirs and goes without force.
    runtime.addRow("grid", {});
    const empty = (await registrar.execute("edit_rows", { collection: "grid", action: "remove", index: 1 })) as Row;
    expect(empty.ok).toBe(true);
  });

  it("a failing paint never changes the result of a write that landed", async () => {
    const setup = agentSetup(AGENT_SINGLE_FORM);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setup.host.painted = () => Promise.reject(new Error("paint failed"));
      const result = await setup.ok("set_answers", { answers: { name: "Ada" } });
      expect(writtenPaths(result)).toEqual(["name"]);
      expect(setup.runtime.formValues().name).toBe("Ada");
      expect(setup.host.calls.some((call) => call.method === "reveal")).toBe(true);
      expect(setup.host.calls.filter((call) => call.method === "announce").at(-1)?.args).toEqual(["An assistant filled 1 field"]);
      const rows = await setup.ok("edit_rows", { collection: "grid", action: "add", values: { amount: 3 } });
      expect(rows.indexes).toEqual([1]);
      const undo = await setup.ok("undo_agent_changes");
      expect((undo.restored as Row[]).map((entry) => entry.path)).toEqual(["name"]);
      expect(undo.rowsRemoved).toEqual([{ collection: "grid", index: 1 }]);
      expect(logged).toHaveBeenCalledWith("[datum-agent] painted", expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});
