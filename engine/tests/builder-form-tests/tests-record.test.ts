/**
 * Record and Assert this, the pure halves: every recorded event
 * kind becomes a line the parser reads back as that statement, the refusals say why, and the
 * Assert this picks write the matching `expect` lines.
 */
import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { assertLines, changedFields, recordLine, recordStep } from "../../form-engine/builder/form-tests/tests-record.js";
import { createTestsNaming } from "../../form-engine/builder/form-tests/tests-words.js";
import type { TestsAssertField, TestsAssertSnapshot, TestsRecordEvent } from "../../form-engine/builder/form-tests/tests-model.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

const naming = createTestsNaming(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE);

/** The statement a line parses to inside a scenario, with no problem. */
function parsed(line: string): unknown {
  const result = kernelParseFormTests(`test "t"\n  ${line}`, formulaFunctionSignatures());
  expect(result.problems, line).toEqual([]);
  expect(result.scenarios).toHaveLength(1);
  const scenario = result.scenarios[0]!;
  return scenario.steps[0];
}

describe("recordStep", () => {
  const cases: Array<{ event: TestsRecordEvent; line: string; statement: Record<string, unknown> }> = [
    { event: { kind: "set", componentId: "applicant_name", path: "applicant_name", value: "Ada \"Lovelace\"" }, line: 'set applicant_name = "Ada \\"Lovelace\\""', statement: { kind: "set", path: "applicant_name", value: 'Ada "Lovelace"' } },
    { event: { kind: "set", componentId: "age", path: "age", value: 41 }, line: "set age = 41", statement: { kind: "set", path: "age", value: 41 } },
    { event: { kind: "set", componentId: "wants_details", path: "wants_details", value: true }, line: "set wants_details = true", statement: { kind: "set", value: true } },
    { event: { kind: "set", componentId: "contact_method", path: "contact_method", value: "phone" }, line: 'set contact_method = "phone"', statement: { kind: "set", value: "phone" } },
    { event: { kind: "set", componentId: "topics", path: "topics", value: { news: true, offers: false, events: true } }, line: 'set topics = ("news", "events")', statement: { kind: "set", value: ["news", "events"] } },
    { event: { kind: "set", componentId: "qty", path: "items[0].qty", value: 2 }, line: "set items[0].qty = 2", statement: { kind: "set", path: "items[0].qty", value: 2 } },
    { event: { kind: "set", componentId: "age", path: "age", value: null }, line: "clear age", statement: { kind: "clear", path: "age" } },
    { event: { kind: "clear", componentId: "email", path: "email" }, line: "clear email", statement: { kind: "clear", path: "email" } },
    { event: { kind: "addRow", componentId: "items", collection: "items", count: 1 }, line: "add row to items", statement: { kind: "addRow", path: "items" } },
    { event: { kind: "continue" }, line: "continue", statement: { kind: "continue" } },
    { event: { kind: "back" }, line: "back", statement: { kind: "back" } },
    { event: { kind: "goTo", page: "contact" }, line: "go to contact", statement: { kind: "goTo", page: "contact" } },
    { event: { kind: "change", path: "email" }, line: "change email", statement: { kind: "change", path: "email" } },
    { event: { kind: "check" }, line: "check", statement: { kind: "check" } },
    { event: { kind: "submit", accepted: true }, line: "submit", statement: { kind: "submit" } }
  ];

  for (const { event, line, statement } of cases) {
    it(`writes ${event.kind} as "${line}", which parses back as that statement`, () => {
      expect(recordLine(event, naming)).toBe(line);
      expect(parsed(line)).toMatchObject(statement);
    });
  }

  it("writes a calendar day as a date literal", () => {
    const line = recordLine({ kind: "set", componentId: "age", path: "age", value: "2026-02-03" }, naming)!;
    expect(line).toBe('set age = @"2026-02-03"');
    expect(parsed(line)).toMatchObject({ kind: "set", value: "2026-02-03" });
  });

  it("records nothing for a row removal it cannot place, and the removal's row when the event names it", () => {
    expect(recordStep({ kind: "removeRow", componentId: "items", collection: "items", count: 0 }, naming)).toEqual({ refused: "removeRow" });
    const withIndex = { kind: "removeRow", componentId: "items", collection: "items", count: 1, index: 1 } as TestsRecordEvent;
    const line = recordLine(withIndex, naming)!;
    expect(line).toBe("remove row 1 of items");
    expect(parsed(line)).toMatchObject({ kind: "removeRow", path: "items", index: 1 });
  });

  it("refuses a path the form does not name, a value the language cannot spell and a page with no id", () => {
    expect(recordStep({ kind: "set", componentId: "x", path: "nowhere", value: 1 }, naming)).toEqual({ refused: "path" });
    expect(recordStep({ kind: "set", componentId: "x", path: "not a path", value: 1 })).toEqual({ refused: "path" });
    expect(recordStep({ kind: "set", componentId: "age", path: "age", value: { street: "Main" } }, naming)).toEqual({ refused: "value" });
    expect(recordStep({ kind: "set", componentId: "age", path: "age", value: Number.NaN }, naming)).toEqual({ refused: "value" });
    expect(recordStep({ kind: "goTo", page: "two words" }, naming)).toEqual({ refused: "page" });
    expect(recordStep({ kind: "change", path: "nowhere" }, naming)).toEqual({ refused: "path" });
  });

  it("writes an emptied checkbox group as a clear", () => {
    expect(recordLine({ kind: "set", componentId: "topics", path: "topics", value: { news: false } }, naming)).toBe("clear topics");
    expect(recordLine({ kind: "set", componentId: "topics", path: "topics", value: [] }, naming)).toBe("clear topics");
  });
});

function field(componentId: string, overrides: Partial<TestsAssertField> = {}): TestsAssertField {
  return { componentId, path: componentId, label: componentId, visible: true, required: false, enabled: true, readonly: false, errors: [], value: null, ...overrides };
}

describe("assertLines", () => {
  const before: TestsAssertSnapshot = {
    fields: [field("email", { required: true }), field("phone", { visible: false }), field("confirm_email"), field("age")],
    page: "contact"
  };
  const after: TestsAssertSnapshot = {
    fields: [field("email"), field("phone", { errors: ["required"] }), field("confirm_email", { errors: ["rule"] }), field("age")],
    page: "contact",
    lastSubmit: "refused"
  };
  const decidesRequired = (id: string): boolean => id === "email";

  it("finds the fields the last event moved", () => {
    expect(changedFields(after, before)).toEqual(["email", "phone", "confirm_email"]);
    expect(changedFields(after, undefined)).toEqual([]);
  });

  it("writes what moved for a moved field, and everything for one picked by hand", () => {
    const lines = assertLines(after, before, { fields: ["email", "phone", "age"] }, { decidesRequired });
    expect(lines).toEqual(["expect email optional", "expect phone visible", "expect error on phone: required", "expect age visible", "expect no error on age"]);
  });

  it("skips required/optional when no requiredWhen decides it", () => {
    expect(assertLines(after, before, { fields: ["email"] })).toEqual([]);
    expect(assertLines(after, undefined, { fields: ["email"] })).toEqual(["expect email visible", "expect no error on email"]);
  });

  it("says only hidden for a hidden field", () => {
    expect(assertLines(before, undefined, { fields: ["phone"] })).toEqual(["expect phone hidden"]);
  });

  it("writes the page, the errors on show and the verdict, each once", () => {
    const lines = assertLines(after, before, { fields: ["phone"], page: true, errors: true, verdict: true }, { decidesRequired });
    expect(lines).toEqual(["expect phone visible", "expect error on phone: required", "expect page = contact", "expect error on confirm_email: rule", "expect refused"]);
    expect(assertLines(before, undefined, { fields: [], errors: true })).toEqual(["expect no errors"]);
    // No Submit yet: no verdict line.
    expect(assertLines(before, undefined, { fields: [], verdict: true })).toEqual([]);
  });

  it("keys fields by value path, so the rows of one repeating field are apart", () => {
    const rowsBefore: TestsAssertSnapshot = { fields: [field("qty", { path: "items[0].qty" }), field("qty", { path: "items[1].qty" })] };
    const rowsAfter: TestsAssertSnapshot = { fields: [field("qty", { path: "items[0].qty" }), field("qty", { path: "items[1].qty", errors: ["rule"] })] };
    expect(changedFields(rowsAfter, rowsBefore)).toEqual(["items[1].qty"]);
    expect(assertLines(rowsAfter, rowsBefore, { fields: ["items[1].qty"] })).toEqual(["expect error on items[1].qty: rule"]);
    expect(assertLines(rowsAfter, rowsBefore, { fields: ["items[0].qty"] })).toEqual(["expect items[0].qty visible", "expect no error on items[0].qty"]);
    // A component id is no pick: two rows share it.
    expect(assertLines(rowsAfter, rowsBefore, { fields: ["qty"] })).toEqual([]);
  });

  it("writes only lines that parse", () => {
    const lines = assertLines(after, before, { fields: after.fields.map((entry) => entry.componentId), page: true, errors: true, verdict: true }, { decidesRequired });
    for (const line of lines) {
      parsed(line);
    }
    expect(lines.length).toBeGreaterThan(4);
  });
});
