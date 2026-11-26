import { describe, expect, it } from "vitest";

import { addStepChoices, addStepFields } from "../../form-engine/builder/form-tests/tests-add-step.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

/**
 * The Add step menu's model: the fields a test may name with a value of
 * their kind to start from, and the statements grouped as the menu draws them. Every line it
 * offers must read back through the parser as a statement, so the menu never writes a problem.
 */

const root = FORM_TESTS_FIXTURE.root;

function statementsOf(groups: ReturnType<typeof addStepChoices>, id: string): string[] {
  return groups.find((group) => group.id === id)?.statements.map((statement) => statement.text) ?? [];
}

describe("addStepFields", () => {
  it("lists the fields by label with a placeholder of their kind", () => {
    const fields = addStepFields(root, FORM_TESTS_FIXTURE);
    const by = (path: string) => fields.find((field) => field.path === path);
    expect(by("applicant_name")).toMatchObject({ label: "Name", placeholder: '""', collection: false });
    expect(by("age")?.placeholder).toBe("0");
    expect(by("wants_details")?.placeholder).toBe("true");
    expect(by("contact_method")?.placeholder).toBe('"email"');
    expect(by("topics")?.placeholder).toBe('("news")');
    expect(by("items")?.collection).toBe(true);
    expect(by("items[0].qty")).toMatchObject({ label: "Quantity", placeholder: "0" });
  });

  it("gives a date field a date literal", () => {
    const form = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "when", type: "date", configuration: { label: "When" } }] } };
    expect(addStepFields(form)[0]?.placeholder).toBe('@"2026-01-01"');
  });
});

describe("addStepChoices", () => {
  it("offers every statement group for a picked field, in the catalog's words", () => {
    const groups = addStepChoices(root, FORM_TESTS_FIXTURE, [], { field: "age" });
    expect(groups.map((group) => group.id)).toEqual(["set", "state", "value", "error", "journey", "rows", "output"]);
    expect(groups[0]?.title).toBe("Set an answer");
    expect(statementsOf(groups, "set")).toEqual(["set age = 0", "clear age"]);
    expect(statementsOf(groups, "state")).toContain("expect age not empty");
    expect(statementsOf(groups, "state")).toHaveLength(10);
    expect(statementsOf(groups, "value")).toEqual(["expect age = 0"]);
    expect(statementsOf(groups, "error")).toEqual(["expect error on age: required", "expect error on age: rule", "expect error on age", "expect no error on age", "expect no errors"]);
    const set = groups.find((group) => group.id === "set")!.statements[0]!;
    expect(set.label).toBe("Set Age");
  });

  it("names the journey's pages, the collections and the PDF layouts", () => {
    const groups = addStepChoices(root, FORM_TESTS_FIXTURE, []);
    const journey = statementsOf(groups, "journey");
    expect(journey.slice(0, 2)).toEqual(["continue", "back"]);
    expect(journey).toContain("go to contact");
    expect(journey).toContain("expect page = review");
    expect(journey.slice(-4)).toEqual(["check", "submit", "expect accepted", "expect refused"]);
    expect(statementsOf(groups, "rows")).toEqual(["add row to items", "remove row 0 of items", "expect rows of items = 1"]);
    const output = statementsOf(groups, "output");
    expect(output).toContain("expect layout = standard");
    expect(output).toContain("expect layout = pets");
    expect(output[0]).toBe('expect submitted applicant_name = ""');
  });

  it("adds the host's own codes to the error group", () => {
    const groups = addStepChoices(root, FORM_TESTS_FIXTURE, ["taxId.unknown", "required"], { field: "email" });
    expect(statementsOf(groups, "error")).toContain("expect error on email: taxId.unknown");
    expect(statementsOf(groups, "error").filter((line) => line.endsWith(": required"))).toHaveLength(1);
  });

  it("leaves out a host code the language cannot spell after the colon", () => {
    const groups = addStepChoices(root, FORM_TESTS_FIXTURE, ["tax id/unknown", "ok.code"], { field: "email" });
    const lines = statementsOf(groups, "error");
    expect(lines).toContain("expect error on email: ok.code");
    expect(lines.some((line) => line.includes("tax id"))).toBe(false);
  });

  it("leaves out what the form cannot answer: no journey moves without a journey, no rows, no layouts", () => {
    const form = { id: "f", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } };
    const groups = addStepChoices(form, undefined, []);
    expect(groups.map((group) => group.id)).toEqual(["set", "state", "value", "error", "journey", "output"]);
    expect(statementsOf(groups, "journey")).toEqual(["check", "submit", "expect accepted", "expect refused"]);
    expect(addStepChoices({ id: "f", type: "form", configuration: {}, children: { content: [] } }, undefined, []).map((group) => group.id)).toEqual(["error", "journey"]);
  });

  it("reads its words from a host catalog", () => {
    const groups = addStepChoices(root, FORM_TESTS_FIXTURE, [], { field: "age", text: { locale: "fr", catalog: { fr: { "tests.addStep.group.set": "Donner une réponse", "tests.addStep.set": "Remplir {field}" } } } });
    expect(groups[0]?.title).toBe("Donner une réponse");
    expect(groups[0]?.statements[0]?.label).toBe("Remplir Age");
  });

  it("offers a Check answers step's Change link for the picked field, only while a journey has such a step", () => {
    const withReview = {
      ...FORM_TESTS_FIXTURE,
      journey: { journeys: [{ id: "apply", pages: [{ id: "about", components: ["age"] }, { id: "check", kind: "review" }] }] }
    } as typeof FORM_TESTS_FIXTURE;
    const groups = addStepChoices(root, withReview, [], { field: "age" });
    const change = groups.find((group) => group.id === "journey")!.statements.find((statement) => statement.text === "change age");
    expect(change?.label).toBe("Change Age from Check answers");
    const parsed = kernelParseFormTests(['test "x"', "  change age"].join("\n"), formulaFunctionSignatures());
    expect(parsed.problems).toEqual([]);
    // The fixture's own journey has no Check answers step: no Change line.
    expect(statementsOf(addStepChoices(root, FORM_TESTS_FIXTURE, [], { field: "age" }), "journey").some((line) => line.startsWith("change "))).toBe(false);
  });

  it("offers only lines the parser reads as statements", () => {
    const fields = addStepFields(root, FORM_TESTS_FIXTURE).filter((field) => !field.collection);
    for (const field of fields) {
      const lines = addStepChoices(root, FORM_TESTS_FIXTURE, ["taxId.unknown"], { field: field.path }).flatMap((group) => group.statements.map((statement) => statement.text));
      const source = ['test "every line"', ...lines.map((line) => `  ${line}`)].join("\n");
      const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
      expect(parsed.problems, `${field.path}: ${JSON.stringify(parsed.problems)}`).toEqual([]);
      expect(parsed.scenarios[0]?.steps).toHaveLength(lines.length);
    }
  });
});
