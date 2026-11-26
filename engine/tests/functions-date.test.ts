import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import { DATE_FUNCTIONS, kernelDateCall, kernelDateHandles } from "../form-engine/rules/evaluator/functions-date.js";

const cases: Array<[string, unknown[], unknown]> = [
  ["isDate", ["2026-02-30"], false],
  ["isDate", ["2024-02-29"], true],
  ["date", ["2026-01-31"], "2026-01-31"],
  ["date", ["2026-01-31T10:00:00Z"], "2026-01-31"],
  ["date", ["nope"], undefined],
  ["date", [5], undefined],
  ["dateAdd", ["2026-01-31", 1, "months"], "2026-02-28"],
  ["dateAdd", ["2024-01-31", 1, "months"], "2024-02-29"],
  ["dateAdd", ["2024-02-29", 1, "years"], "2025-02-28"],
  ["dateAdd", ["2026-10-07", 30, "days"], "2026-11-06"],
  ["dateAdd", ["2026-10-07", -7, "days"], "2026-09-30"],
  ["dateAdd", ["2026-10-07", 2, "weeks"], "2026-10-21"],
  ["dateAdd", ["2026-10-07", 1.9, "days"], "2026-10-08"],
  ["dateAdd", ["2026-03-31", -1, "months"], "2026-02-28"],
  ["dateAdd", ["2026-10-07", NaN, "days"], undefined],
  ["dateAdd", ["2026-10-07", Infinity, "days"], undefined],
  ["dateAdd", [undefined, 1, "days"], undefined],
  ["dateDiff", ["2026-10-07", undefined, "days"], undefined],
  ["dateDiff", ["2026-10-07", "", "days"], undefined],
  ["dateDiff", ["nope", "2026-10-07", "days"], undefined],
  ["dateAdd", ["2026-10-07", "1", "days"], undefined],
  ["dateAdd", ["2026-10-07", 1, "hours"], undefined],
  ["dateAdd", ["9999-12-31", 1, "days"], undefined],
  ["dateAdd", ["0001-01-01", -1, "days"], undefined],
  ["dateAdd", ["9999-12-01", 1, "months"], undefined],
  ["dateDiff", ["2026-01-01", "2026-01-31", "days"], 30],
  ["dateDiff", ["2026-01-31", "2026-01-01", "days"], -30],
  ["dateDiff", ["2026-01-01", "2026-01-20", "weeks"], 2],
  ["dateDiff", ["2026-01-20", "2026-01-01", "weeks"], -2],
  ["dateDiff", ["2026-01-15", "2026-03-14", "months"], 1],
  ["dateDiff", ["2026-01-15", "2026-03-15", "months"], 2],
  ["dateDiff", ["2026-03-14", "2026-01-15", "months"], -1],
  ["dateDiff", ["2000-05-10", "2026-10-07", "years"], 26],
  ["dateDiff", ["2000-10-08", "2026-10-07", "years"], 25],
  ["dateDiff", ["2026-10-07", "2000-10-08", "years"], -25],
  ["dateDiff", ["2026-01-01", "x", "days"], undefined],
  ["dateDiff", ["2026-01-01", "2026-01-02", "decades"], undefined],
  ["year", ["2026-10-07"], 2026],
  ["month", ["2026-10-07"], 10],
  ["day", ["2026-10-07"], 7],
  ["year", [undefined], undefined],
  ["dayOfWeek", ["2026-10-05"], 1],
  ["dayOfWeek", ["2026-10-11"], 7],
  ["dayOfWeek", ["1969-12-31"], 3],
  ["dayOfWeek", ["0001-01-01"], 1],
  ["isWeekend", ["2026-10-10"], true],
  ["isWeekend", ["2026-10-09"], false],
  ["isWeekend", [null], undefined],
  ["startOfMonth", ["2026-10-07"], "2026-10-01"],
  ["endOfMonth", ["2026-10-07"], "2026-10-31"],
  ["endOfMonth", ["2024-02-10"], "2024-02-29"],
  ["endOfMonth", ["2026-02-10"], "2026-02-28"],
  ["endOfMonth", ["2026-12-10"], "2026-12-31"],
  ["endOfMonth", ["bad"], undefined],
  // A count that is not finite or reaches past year 9999 is no date, never "0NaN-aN-aN".
  ["dateAdd", ["2024-02-29", 1e308, "weeks"], undefined],
  ["dateAdd", ["2024-02-29", -1e308, "weeks"], undefined],
  ["dateAdd", ["2024-02-29", 1e308, "days"], undefined],
  ["dateAdd", ["2024-02-29", 1e308, "years"], undefined],
  ["dateAdd", ["2024-02-29", 1e308, "months"], undefined],
  ["dateAdd", ["2024-02-29", 4000001, "days"], undefined],
  ["dateAdd", ["2024-02-29", 600000, "weeks"], undefined],
  ["dateAdd", ["2024-02-29", 52, "weeks"], "2025-02-27"],
  // The end-of-month clamp is a complete month, so a diff undoes an add.
  ["dateDiff", ["2024-01-31", "2024-02-29", "months"], 1],
  ["dateDiff", ["2024-01-31", "2024-02-28", "months"], 0],
  ["dateDiff", ["2023-01-31", "2023-02-28", "months"], 1],
  ["dateDiff", ["2024-01-30", "2024-02-29", "months"], 1],
  ["dateDiff", ["2024-01-31", "2024-04-30", "months"], 3],
  ["dateDiff", ["2000-02-29", "2001-02-28", "years"], 1],
  ["dateDiff", ["2000-02-29", "2001-02-27", "years"], 0],
  ["dateDiff", ["2000-02-29", "2004-02-29", "years"], 4],
  ["dateDiff", ["2024-02-29", "2024-01-31", "months"], -1],
  ["dateDiff", ["2024-03-31", "2024-02-29", "months"], -1],
  ["dateDiff", ["2024-06-01", "2024-05-01", "years"], 0],
  ["dateDiff", ["2024-06-01", "2024-06-01", "months"], 0],
  ["dateDiff", ["2026-01-01", "2026-01-01", "weeks"], 0],
  ["dateDiff", ["2026-01-02", "2026-01-01", "weeks"], 0]
];

describe("date functions", () => {
  it.each(cases)("%s(%j) = %j", (name, args, expected) => {
    expect(kernelDateCall(name, args)).toBe(expected);
  });

  it("a diff undoes an add at month ends, in both directions", () => {
    const starts = ["2024-01-31", "2024-02-29", "2023-01-31", "2024-03-31", "2024-05-31", "2000-02-29", "2024-12-31", "2026-10-07"];
    for (const start of starts) {
      for (const unit of ["months", "years"]) {
        for (let n = -30; n <= 30; n += 1) {
          const moved = kernelDateCall("dateAdd", [start, n, unit]);
          if (moved === undefined) continue;
          expect(kernelDateCall("dateDiff", [start, moved, unit]), `${start} ${n} ${unit}`).toBe(n);
          // And the answer is antisymmetric.
          const back = kernelDateCall("dateDiff", [moved, start, unit]) as number;
          const forth = kernelDateCall("dateDiff", [start, moved, unit]) as number;
          expect(back + forth, `${start} ${moved} ${unit}`).toBe(0);
        }
      }
    }
  });

  it("handles every date-group name in the table except the contextual ones", () => {
    const names = FORMULA_FUNCTION_TABLE.filter((row) => row.group === "date" && !["today", "age"].includes(row.name)).map(
      (row) => row.name
    );
    for (const name of names) {
      expect(kernelDateHandles(name), name).toBe(true);
    }
    expect(kernelDateHandles("today")).toBe(false);
    expect(kernelDateHandles("age")).toBe(false);
    expect(kernelDateHandles("nope")).toBe(false);
  });

  it("lists every declared kernel function once", () => {
    const names = DATE_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("kernel"))).toBe(true);
  });
});
