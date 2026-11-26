import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import { FORMULA_FUNCTION_DOCS } from "../form-engine/core/expressions/function-docs.js";

const doc = readFileSync(resolve(__dirname, "../../docs/formulas.md"), "utf8");

describe("docs/formulas.md", () => {
  it("lists every built-in function of the table, so the doc and the table cannot drift", () => {
    const missing = FORMULA_FUNCTION_TABLE.map((row) => row.name).filter(
      (name) => !doc.includes("`" + name + "(")
    );
    expect(missing).toEqual([]);
  });

  it("carries each function's summary and its FEEL spelling", () => {
    for (const row of FORMULA_FUNCTION_TABLE) {
      expect(doc, row.name).toContain(FORMULA_FUNCTION_DOCS[row.name]!.summary);
      if ("feelName" in row) {
        expect(doc, row.name).toContain("`" + row.feelName + "`");
      }
    }
  });
});
