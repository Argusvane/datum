/**
 * Curated built-in function calls for PAR-04, each a `value` rule over literals (and a fixed
 * `today`), so the result is the function's alone. The field type is the one the result's kind
 * needs (a text field refuses a number). `expected` pins what both engines must say, so two engines
 * agreeing on a wrong answer is also caught; a case without it (`undefined`) is compared across
 * the engines only.
 */
export type FunctionResultKind = "text" | "number" | "checkbox" | "date";

export interface FunctionCase {
  /** `<function>` or `<function>:<what the case shows>`. */
  id: string;
  formula: string;
  kind: FunctionResultKind;
  expected: string | number | boolean;
}

/** The clock every case runs on. */
export const FUNCTION_TODAY = "2026-01-15";

export const FUNCTION_CASES: readonly FunctionCase[] = [
  { id: "upper", formula: 'upper("abc é")', kind: "text", expected: "ABC É" },
  { id: "lower", formula: 'lower("ABC")', kind: "text", expected: "abc" },
  { id: "trim", formula: 'trim("  a b  ")', kind: "text", expected: "a b" },
  { id: "concat", formula: 'concat("a", "b", "c")', kind: "text", expected: "abc" },
  { id: "substring", formula: 'substring("abcdef", 2, 3)', kind: "text", expected: "bcd" },
  { id: "replace", formula: 'replace("a-b-c", "-", "+")', kind: "text", expected: "a+b+c" },
  { id: "padStart", formula: 'padStart("7", 3, "0")', kind: "text", expected: "007" },
  { id: "len", formula: 'len("héllo")', kind: "number", expected: 5 },
  { id: "indexOf", formula: 'indexOf("hello", "l")', kind: "number", expected: 3 },
  { id: "startsWith", formula: 'startsWith("hello", "he")', kind: "checkbox", expected: true },
  { id: "contains", formula: 'contains("hello", "xyz")', kind: "checkbox", expected: false },
  { id: "last+split", formula: 'last(split("a@b.co", "@"))', kind: "text", expected: "b.co" },
  { id: "join+reverse+sort", formula: 'join(reverse(sort(split("b,a,c", ","))), ";")', kind: "text", expected: "c;b;a" },
  { id: "count+distinct", formula: 'count(distinct(split("a,b,a", ",")))', kind: "number", expected: 2 },
  { id: "text:number", formula: "text(1234.5)", kind: "text", expected: "1234.5" },
  { id: "number:text", formula: 'number(trim(" 42.5 "))', kind: "number", expected: 42.5 },
  { id: "round:half", formula: "round(2.5) + round(-2.5)", kind: "number", expected: 1 },
  { id: "roundTo", formula: "roundTo(10 * 0.1 * 3, 2)", kind: "number", expected: 3 },
  { id: "floor+ceil", formula: "floor(-1.5) + ceil(-1.5)", kind: "number", expected: -3 },
  { id: "abs+clamp", formula: "clamp(abs(-5), 0, 3)", kind: "number", expected: 3 },
  { id: "modulo:negative", formula: "modulo(-7, 3)", kind: "number", expected: -1 },
  { id: "power+sqrt", formula: "power(2, 10) + sqrt(144)", kind: "number", expected: 1036 },
  { id: "sum+min+max+avg", formula: "sum(1, 2, 3) + min(4, 2) + max(4, 2) + avg(2, 4)", kind: "number", expected: 15 },
  { id: "float:addition", formula: "0.1 + 0.2", kind: "number", expected: 0.30000000000000004 },
  { id: "divide:large", formula: "123456789012 / 1000", kind: "number", expected: 123456789.012 },
  { id: "if:else-if", formula: 'if 150 >= 1000 then "gold" else if 150 >= 100 then "silver" else "bronze"', kind: "text", expected: "silver" },
  { id: "between+in", formula: "5 between 1 and 10 and 7 in (5, 7) and 3 in [1..4]", kind: "checkbox", expected: true },
  { id: "coalesce", formula: 'coalesce(if 1 > 2 then "x", "fallback")', kind: "text", expected: "fallback" },
  { id: "today", formula: "today()", kind: "date", expected: "2026-01-15" },
  { id: "dateAdd:month-end", formula: 'dateAdd(date("2026-01-31"), 1, "months")', kind: "date", expected: "2026-02-28" },
  { id: "dateAdd:leap", formula: 'dateAdd(date("2024-02-29"), 1, "years")', kind: "date", expected: "2025-02-28" },
  { id: "dateDiff", formula: 'dateDiff(date("2026-01-01"), today(), "days")', kind: "number", expected: 14 },
  { id: "age", formula: 'age(date("2000-01-16"))', kind: "number", expected: 25 },
  { id: "dayOfWeek+isWeekend", formula: 'dayOfWeek(date("2026-01-17")) + (if isWeekend(date("2026-01-17")) then 10 else 0)', kind: "number", expected: 16 },
  { id: "startOfMonth+endOfMonth", formula: 'text(startOfMonth(today())) = "2026-01-01" and text(endOfMonth(today())) = "2026-01-31"', kind: "checkbox", expected: true }
];
