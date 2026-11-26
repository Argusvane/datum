import { describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { presentationForm } from "./fixtures/presentation-form.js";
import { agentSetup, personTypes, type AgentSetup } from "./fixtures/agent-form.js";

/**
 * Own fields written by the agent: over the shared presentation fixture, the journey `apply`'s page `income` owns
 * `m1`…`m3` (answers under `@apply.m1`…) and the worked-out `income_total`, which sets the form's
 * `annual_income` to their sum. On that page they are written like form fields, with real pre-
 * and post-images, the worked-out target reported, marked the agent's and journaled with them;
 * from another page they are refused with the hint that names navigate.
 */

type Row = Record<string, unknown>;

/** The fixture on `income`: the person gave the email `details` requires, the agent moved on. */
async function onIncome(): Promise<AgentSetup> {
  const setup = agentSetup(presentationForm(), { dataSources: false });
  personTypes(setup.runtime, { email: "ana@example.ca" });
  await setup.ok("navigate", { to: "next" });
  expect(setup.runtime.journeyView()?.pageId).toBe("income");
  return setup;
}

describe("own fields on the page shown", () => {
  it("are written by their @ path, and the worked-out target is reported with its display and source", async () => {
    const setup = await onIncome();
    const result = await setup.ok("set_answers", { answers: { "@apply.m1": 2100, "@apply.m2": 2100, "@apply.m3": 2300 } });
    expect((result.written as Row[]).map((entry) => [entry.path, entry.value, entry.previous])).toEqual([
      ["@apply.m1", 2100, null],
      ["@apply.m2", 2100, null],
      ["@apply.m3", 2300, null]
    ]);
    expect(result.refused).toEqual([]);
    expect(result.workedOut).toEqual([{ path: "annual_income", display: "6,500", from: "@apply.m3" }]);
    expect(setup.runtime.state().values).toMatchObject({ "@apply.m1": 2100, "@apply.m2": 2100, "@apply.m3": 2300, annual_income: 6500 });
    // The own answers stay in the browser: never among the submitted values.
    expect(setup.runtime.submittableValues()).not.toHaveProperty("@apply.m1");
  });

  it("an own field may be written by its id too, and its pre-image is its stored answer, never lost to formValues()", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { m1: 100 } });
    const second = await setup.ok("set_answers", { answers: { m1: 250 } });
    expect((second.written as Row[])[0]).toMatchObject({ path: "@apply.m1", id: "m1", value: 250, previous: 100 });
    expect(second.workedOut).toEqual([{ path: "annual_income", display: "250", from: "@apply.m1" }]);
  });

  it("the worked-out target is the agent's (the one exception to the provenance rule) and undo restores it with the own fields", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { "@apply.m1": 1000, "@apply.m2": 2000 } });
    const answers = await setup.ok("get_answers", { paths: ["annual_income"] });
    expect((answers.answers as Row[]).find((answer) => answer.id === "annual_income")).toMatchObject({ value: 3000, lastWriter: "agent" });
    expect(setup.registration.provenance("agent")?.paths).toContain("annual_income");
    const undone = await setup.ok("undo_agent_changes");
    expect((undone.restored as Row[]).map((entry) => entry.path).sort()).toEqual(["@apply.m1", "@apply.m2", "annual_income"]);
    expect(undone.kept).toEqual([]);
    const values = setup.runtime.state().values as Row;
    expect(values["@apply.m1"]).toBeUndefined();
    expect(values["@apply.m2"]).toBeUndefined();
    expect(values.annual_income).toBeUndefined();
    // The writers go back too (writersBefore): neither the own field nor the target is the agent's.
    expect(setup.registration.provenance("agent")?.paths).toEqual([]);
  });

  it("the person's later edit of an own field is kept by the undo, as any field's", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { "@apply.m1": 1000 } });
    personTypes(setup.runtime, { "@apply.m1": 1200 });
    const undone = await setup.ok("undo_agent_changes");
    expect(undone.kept).toContainEqual({ path: "@apply.m1", reason: "person-edited" });
    expect((setup.runtime.state().values as Row)["@apply.m1"]).toBe(1200);
  });

  it("describe_form lists them writable with presentation: true; get_answers.presentation names the path", async () => {
    const setup = await onIncome();
    const described = await setup.ok("describe_form");
    const own = (described.fields as Row[]).filter((field) => field.presentation === true);
    expect(own.map((field) => [field.path, field.writable])).toEqual([
      ["@apply.m1", true],
      ["@apply.m2", true],
      ["@apply.m3", true]
    ]);
    await setup.ok("set_answers", { answers: { "@apply.m3": 5 } });
    const answers = await setup.ok("get_answers");
    expect(answers.presentation).toEqual([{ id: "m3", label: "Month 3", value: 5, display: "5", page: "income", path: "@apply.m3", writable: true, lastWriter: "agent" }]);
  });
});

describe("own fields of another page", () => {
  it("are refused not-writable { presentation } with the hint that names navigate", async () => {
    const setup = agentSetup(presentationForm(), { dataSources: false });
    expect(setup.runtime.journeyView()?.pageId).toBe("details");
    const refused = await setup.refused("set_answers", { answers: { "@apply.m1": 10 } });
    expect(refused.code).toBe("nothing-written");
    const [item] = (refused.details as { refused: Row[] }).refused;
    expect(item).toEqual({
      path: "@apply.m1",
      code: "not-writable",
      message: "The field '@apply.m1' belongs to another page of the journey.",
      hint: "This field belongs to another page of the journey; move there with navigate, then write it.",
      details: { path: "@apply.m1", reason: "presentation" }
    });
  });

  it("are written in place beside a form field that is on the page, the other refused one by one", async () => {
    const setup = agentSetup(presentationForm(), { dataSources: false });
    const result = await setup.ok("set_answers", { answers: { email: "ana@example.ca", m2: 3 } });
    expect((result.written as Row[]).map((entry) => entry.path)).toEqual(["email"]);
    expect((result.refused as Row[]).map((entry) => [entry.path, (entry.details as Row).reason])).toEqual([["@apply.m2", "presentation"]]);
  });

  it("the presentation's container is never written, and keeps its wording", async () => {
    const setup = await onIncome();
    const refused = await setup.refused("set_answers", { answers: { "@apply": 1 } });
    const [item] = (refused.details as { refused: Row[] }).refused;
    expect(item).toMatchObject({ code: "not-writable", hint: "This field belongs to the page's presentation and cannot be written by an assistant.", details: { reason: "presentation" } });
  });
});

describe("own answers in the counts, and the person's later edit of an own field", () => {
  /** The fixture with the own field `m1` required on `income`: a required own answer can go missing. */
  function withRequiredM1(): FormDefinition {
    const definition = JSON.parse(JSON.stringify(presentationForm())) as FormDefinition;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        const node = value as Row;
        if (node.id === "m1" && node.type === "number") {
          node.configuration = { ...(node.configuration as Row), required: true };
        }
        Object.values(node).forEach(walk);
      }
    };
    walk(definition);
    return definition;
  }

  it("check's missingRequired drops a required own field once written, and describe_form counts the own answers (stored values, not formValues())", async () => {
    const setup = agentSetup(withRequiredM1(), { dataSources: false });
    personTypes(setup.runtime, { email: "ana@example.ca" });
    await setup.ok("navigate", { to: "next" });
    const before = await setup.ok("check", { scope: "page" });
    expect((before.missingRequired as Row[]).map((entry) => entry.path)).toContain("@apply.m1");
    await setup.ok("set_answers", { answers: { "@apply.m1": 100, "@apply.m2": 200 } });
    const after = await setup.ok("check", { scope: "page" });
    expect((after.missingRequired as Row[]).map((entry) => entry.path)).not.toContain("@apply.m1");
    const described = await setup.ok("describe_form");
    // m1, m2 and the worked-out annual_income (300) are answered; m3 is not.
    expect(described.counts).toMatchObject({ answered: 3, missingRequired: 0 });
  });

  it("the person rewriting an own field takes the worked-out target away from the agent: no change event, lifted from the own key", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { "@apply.m1": 100, "@apply.m2": 200 } });
    expect(setup.registration.provenance("page")?.paths).toEqual(["annual_income"]);
    personTypes(setup.runtime, { "@apply.m1": 500 });
    expect(setup.runtime.state().values).toMatchObject({ "@apply.m1": 500, annual_income: 700 });
    expect(setup.registration.provenance("page")?.paths).toEqual([]);
    const answers = await setup.ok("get_answers", { paths: ["annual_income"] });
    expect((answers.answers as Row[]).find((answer) => answer.id === "annual_income")).toMatchObject({ value: 700, lastWriter: "other" });
  });

  it("get_answers lists a filled own field with its stored value, under answers as under presentation, and finds it by its @ path (stored values, not formValues())", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { "@apply.m1": 2100, "@apply.m2": 2100 } });
    const all = await setup.ok("get_answers", { includeEmpty: true });
    const own = (all.answers as Row[]).filter((answer) => String(answer.path).startsWith("@"));
    expect(own.map((answer) => [answer.path, answer.value, answer.display, answer.lastWriter ?? null])).toEqual([
      ["@apply.m1", 2100, "2,100", "agent"],
      ["@apply.m2", 2100, "2,100", "agent"],
      ["@apply.m3", null, "", null]
    ]);
    // One result never contradicts itself: the presentation block carries the same values.
    expect((all.presentation as Row[]).map((entry) => [entry.path, entry.value])).toEqual([
      ["@apply.m1", 2100],
      ["@apply.m2", 2100]
    ]);
    const byPath = await setup.ok("get_answers", { paths: ["@apply.m1"] });
    expect((byPath.answers as Row[]).map((answer) => [answer.path, answer.id, answer.value])).toEqual([["@apply.m1", "m1", 2100]]);
    expect(byPath.unknown).toBeUndefined();
    // Without includeEmpty, a filled own field is listed and an empty one is not.
    const filled = await setup.ok("get_answers");
    expect((filled.answers as Row[]).filter((answer) => String(answer.path).startsWith("@")).map((answer) => answer.path)).toEqual(["@apply.m1", "@apply.m2"]);
  });

  it("the undo of an own field the person rewrote keeps only that field: the worked-out target the overlay recomputed is neither kept nor named in the note", async () => {
    const setup = await onIncome();
    await setup.ok("set_answers", { answers: { "@apply.m1": 100, "@apply.m2": 200 } });
    personTypes(setup.runtime, { "@apply.m1": 500 });
    const undone = await setup.ok("undo_agent_changes");
    expect((undone.restored as Row[]).map((entry) => entry.path)).toEqual(["@apply.m2"]);
    expect(undone.kept).toEqual([{ path: "@apply.m1", reason: "person-edited" }]);
    expect(undone.note).toEqual(["The person changed 'Month 1' after you did; it was left as they set it."]);
    // The target follows its sources: m1 as the person set it, m2 gone.
    expect(setup.runtime.state().values).toMatchObject({ "@apply.m1": 500, annual_income: 500 });
    expect((setup.runtime.state().values as Row)["@apply.m2"]).toBeUndefined();
  });
});

describe("the set_answers description", () => {
  it("says own fields are written the same way, before the sentence about refused fields", async () => {
    const setup = agentSetup(presentationForm(), { dataSources: false });
    const tool = setup.registrar.tools().find((entry) => entry.name === "set_answers");
    const description = tool?.description ?? "";
    const inserted = "Fields that belong to a journey page's own presentation (paths starting with @, listed by describe_form) are written the same way.";
    expect(description).toContain(`${inserted} Fields that cannot be written are refused one by one`);
  });
});
