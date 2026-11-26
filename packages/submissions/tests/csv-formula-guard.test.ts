import { describe, expect, it } from "vitest";
import { guardSpreadsheetCell, type FormDefinition } from "@argusvane/datum-engine";

import { recordsToCsv, walkValueFields, type SubmissionRecord } from "../src/index.js";

const FORM: FormDefinition = {
  id: "survey",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: { title: "Survey" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "age", type: "number", configuration: { label: "Age" } },
        { id: "toppings", type: "checkboxes", configuration: { options: ["a", "b"] } },
        { id: "agree", type: "checkbox", configuration: {} }
      ]
    }
  }
};

function record(values: Record<string, unknown>, extra: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    id: "r1",
    formId: "survey",
    formVersion: "1.0.0",
    receivedAt: "2026-09-13T09:00:00.000Z",
    status: "accepted",
    document: { versionContext: { form: { id: "survey", version: "1.0.0" }, client: { runtimeVersion: "1", rendererVersion: "1", schemaVersion: "1" } }, submission: { locale: "en", values } },
    digest: "d-r1",
    submissionKey: "k-r1",
    locale: "en",
    source: "renderer",
    errors: [],
    ...extra
  };
}

/** The first record's cells, read back as the rows a spreadsheet would show. */
function row(values: Record<string, unknown>, extra: Partial<SubmissionRecord> = {}): string[] {
  const line = recordsToCsv([record(values, extra)], walkValueFields(FORM)).split("\r\n")[1] ?? "";
  // The cells under test carry no comma or quote, so a plain split is the row.
  return line.split(",");
}

const NAME = 7;

describe("CSV export guards a cell a spreadsheet would run as a formula", () => {
  it.each([
    ["=", "=1+1"],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(A1)"],
    ["a tab", "\tcmd"]
  ])("an answer leading with %s gets a leading apostrophe", (_name, typed) => {
    const cells = row({ name: typed });
    expect(cells[NAME]).toBe(`'${typed}`);
  });

  it("a carriage return or line feed lead is guarded and the cell quoted", () => {
    for (const typed of ["\r=1", "\n=1"]) {
      const csv = recordsToCsv([record({ name: typed })], walkValueFields(FORM));
      expect(csv).toContain(`"'${typed}"`);
    }
  });

  it("an apostrophe already leading counts, so the text can come back as it went out", () => {
    expect(row({ name: "'=1" })[NAME]).toBe("''=1");
    expect(row({ name: "'plain" })[NAME]).toBe("'plain");
  });

  it("leaves ordinary text alone, a formula character inside a cell included", () => {
    expect(row({ name: "Ada" })[NAME]).toBe("Ada");
    expect(row({ name: "a=b" })[NAME]).toBe("a=b");
    expect(row({ name: "1-2" })[NAME]).toBe("1-2");
  });

  it("a number answer is not text: a negative number stays as it is, a boolean too", () => {
    const cells = row({ name: "x", age: -5, agree: true });
    expect(cells[NAME + 1]).toBe("-5");
    expect(cells[NAME + 3]).toBe("true");
  });

  it("the same number typed as a string answer is text, so it is guarded", () => {
    expect(row({ name: "x", age: "-5" })[NAME + 1]).toBe("'-5");
  });

  it("guards a list answer led by a number as a whole cell", () => {
    expect(row({ toppings: [-1, "x"] })[NAME + 2]).toBe("'-1|x");
  });

  it("guards each text entry of a list answer", () => {
    expect(row({ toppings: ["=a", "b", "@c"] })[NAME + 2]).toBe("'=a|b|'@c");
  });

  it("guards the record columns and the headings, which a form's author or a host chose", () => {
    const cells = row({ name: "x" }, { id: "=cmd", formVersion: "+1" });
    expect(cells[0]).toBe("'=cmd");
    expect(cells[4]).toBe("'+1");
    const heading = recordsToCsv([], [{ ...walkValueFields(FORM)[0]!, valuePath: "=evil" }]).split("\r\n")[0] ?? "";
    expect(heading.split(",")).toContain("'=evil");
  });

  it("applies the rule the translation exchange uses: each lead is one shared helper", () => {
    for (const typed of ["=1", "+1", "-1", "@a", "\tx", "'=1", "''@a", "plain", "a=b", ""]) {
      expect(row({ name: typed })[NAME]).toBe(csvCellOf(guardSpreadsheetCell(typed)));
    }
  });
});

/** A cell as the CSV writes it: quoted when it holds a comma, quote or line break. */
function csvCellOf(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
