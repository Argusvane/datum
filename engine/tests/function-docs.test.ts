import { describe, expect, it } from "vitest";

import { FORMULA_FUNCTION_DOCS } from "../form-engine/core/expressions/function-docs.js";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";

/** The words beside the table (split out so the runtime bundle carries the names and arity alone). */
describe("FORMULA_FUNCTION_DOCS", () => {
  it("documents every table row with a summary and an example that calls it, and nothing else", () => {
    const names = FORMULA_FUNCTION_TABLE.map((row) => row.name);
    expect(Object.keys(FORMULA_FUNCTION_DOCS).sort()).toEqual([...names].sort());
    for (const name of names) {
      const doc = FORMULA_FUNCTION_DOCS[name]!;
      expect(doc.summary.length, name).toBeGreaterThan(8);
      expect(doc.example, name).toContain(name + "(");
    }
  });
});
