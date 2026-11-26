/**
 * The formula function library as plain data: one row per built-in a formula may call. It is
 * the single source for the parser's name and arity check (through
 * {@link formulaFunctionSignatures}), for `isEvaluableExpression`, for the journey findings'
 * result typing (`returns`), for the builder's autocomplete and snippet toolbar, and for the
 * generated docs. Each row's one-line summary and example live beside it in `function-docs.ts`,
 * which only the builder and the docs read, so the runtime bundle carries the names and arity
 * alone. Kernel-shaped code never imports it as a constant: the kernel's evaluator
 * switches on the names itself, and the parser receives the signatures as an argument.
 *
 * Names are camelCase identifiers because the formula grammar has no names with spaces;
 * `feelName` carries the DMN FEEL spelling when it differs (`startsWith` is FEEL's
 * `starts with`). A row marked `contextual` reads the evaluation context, not only its
 * arguments: `today()` and `age()` take the host's day, `rowIndex()` and `rowCount()` the
 * repeating section's position. Such calls are handled in `kernelEvaluateExpression` and never
 * reach a function group.
 *
 * Arity: a variadic row takes its last parameter any number of times (`max` unbounded); `min`
 * says how many arguments it needs at least (default none). A fixed row needs every parameter
 * not spelt with a trailing `?`.
 */

export type FormulaReturnKind = "number" | "text" | "boolean" | "list" | "date" | "any";

export type FormulaFunctionGroup = "logic" | "text" | "number" | "list" | "date" | "scope";

export interface FormulaFunctionRow {
  /** The identifier a formula calls. */
  readonly name: string;
  /** Parameter names in order; an optional one ends in `?`, a variadic row repeats its last. */
  readonly params: readonly string[];
  /** The last parameter may repeat without bound. */
  readonly variadic?: true;
  /** Fewest arguments accepted; defaults to the required parameters (none when variadic). */
  readonly min?: number;
  /** What a call yields, for the findings' typing and the docs. */
  readonly returns: FormulaReturnKind;
  /** The DMN FEEL spelling when it differs from `name`. */
  readonly feelName?: string;
  /** The toolbar and Variables panel group. */
  readonly group: FormulaFunctionGroup;
  /** Reads the evaluation context (the day, the row position), not only its arguments. */
  readonly contextual?: true;
}

export const FORMULA_FUNCTION_TABLE = [
  // Logic
  {
    name: "coalesce",
    params: ["value"],
    variadic: true,
    min: 1,
    returns: "any",
    group: "logic"
  },
  {
    name: "empty",
    params: ["value"],
    returns: "boolean",
    group: "logic"
  },
  {
    name: "isNumber",
    params: ["value"],
    returns: "boolean",
    group: "logic"
  },
  {
    name: "isDate",
    params: ["value"],
    returns: "boolean",
    group: "logic"
  },
  // Text
  {
    name: "concat",
    params: ["value"],
    variadic: true,
    returns: "text",
    group: "text"
  },
  {
    name: "len",
    params: ["value"],
    returns: "number",
    feelName: "string length",
    group: "text"
  },
  {
    name: "upper",
    params: ["text"],
    returns: "text",
    feelName: "upper case",
    group: "text"
  },
  {
    name: "lower",
    params: ["text"],
    returns: "text",
    feelName: "lower case",
    group: "text"
  },
  {
    name: "titleCase",
    params: ["text"],
    returns: "text",
    group: "text"
  },
  {
    name: "trim",
    params: ["text"],
    returns: "text",
    group: "text"
  },
  {
    name: "startsWith",
    params: ["text", "prefix"],
    returns: "boolean",
    feelName: "starts with",
    group: "text"
  },
  {
    name: "endsWith",
    params: ["text", "suffix"],
    returns: "boolean",
    feelName: "ends with",
    group: "text"
  },
  {
    name: "contains",
    params: ["haystack", "needle"],
    returns: "boolean",
    group: "text"
  },
  {
    name: "substring",
    params: ["text", "start", "length?"],
    returns: "text",
    group: "text"
  },
  {
    name: "indexOf",
    params: ["haystack", "needle"],
    returns: "number",
    group: "text"
  },
  {
    name: "replace",
    params: ["text", "find", "with"],
    returns: "text",
    group: "text"
  },
  {
    name: "split",
    params: ["text", "separator"],
    returns: "list",
    group: "text"
  },
  {
    name: "join",
    params: ["list", "separator"],
    returns: "text",
    feelName: "string join",
    group: "text"
  },
  {
    name: "matches",
    params: ["text", "pattern"],
    returns: "boolean",
    group: "text"
  },
  {
    name: "text",
    params: ["value"],
    returns: "text",
    feelName: "string",
    group: "text"
  },
  {
    name: "padStart",
    params: ["text", "length", "fill"],
    returns: "text",
    group: "text"
  },
  // Numbers
  {
    name: "sum",
    params: ["value"],
    variadic: true,
    returns: "number",
    group: "number"
  },
  {
    name: "min",
    params: ["value"],
    variadic: true,
    min: 1,
    returns: "number",
    group: "number"
  },
  {
    name: "max",
    params: ["value"],
    variadic: true,
    min: 1,
    returns: "number",
    group: "number"
  },
  {
    name: "avg",
    params: ["value"],
    variadic: true,
    min: 1,
    returns: "number",
    feelName: "mean",
    group: "number"
  },
  {
    name: "count",
    params: ["value"],
    returns: "number",
    group: "number"
  },
  {
    name: "abs",
    params: ["number"],
    returns: "number",
    group: "number"
  },
  {
    name: "round",
    params: ["number"],
    returns: "number",
    group: "number"
  },
  {
    name: "roundTo",
    params: ["number", "scale"],
    returns: "number",
    feelName: "decimal",
    group: "number"
  },
  {
    name: "roundUp",
    params: ["number", "scale?"],
    returns: "number",
    feelName: "round up",
    group: "number"
  },
  {
    name: "roundDown",
    params: ["number", "scale?"],
    returns: "number",
    feelName: "round down",
    group: "number"
  },
  {
    name: "floor",
    params: ["number"],
    returns: "number",
    group: "number"
  },
  {
    name: "ceil",
    params: ["number"],
    returns: "number",
    feelName: "ceiling",
    group: "number"
  },
  {
    name: "modulo",
    params: ["number", "divisor"],
    returns: "number",
    group: "number"
  },
  {
    name: "power",
    params: ["base", "exponent"],
    returns: "number",
    group: "number"
  },
  {
    name: "sqrt",
    params: ["number"],
    returns: "number",
    group: "number"
  },
  {
    name: "clamp",
    params: ["number", "low", "high"],
    returns: "number",
    group: "number"
  },
  {
    name: "number",
    params: ["text"],
    returns: "number",
    group: "number"
  },
  // Lists
  {
    name: "selected",
    params: ["value"],
    returns: "list",
    group: "list"
  },
  {
    name: "first",
    params: ["list"],
    returns: "any",
    group: "list"
  },
  {
    name: "last",
    params: ["list"],
    returns: "any",
    group: "list"
  },
  {
    name: "distinct",
    params: ["list"],
    returns: "list",
    feelName: "distinct values",
    group: "list"
  },
  {
    name: "sort",
    params: ["list"],
    returns: "list",
    group: "list"
  },
  {
    name: "reverse",
    params: ["list"],
    returns: "list",
    group: "list"
  },
  {
    name: "append",
    params: ["list", "item"],
    returns: "list",
    group: "list"
  },
  {
    name: "pluck",
    params: ["rows", "key"],
    returns: "list",
    group: "list"
  },
  {
    name: "any",
    params: ["list"],
    returns: "boolean",
    group: "list"
  },
  {
    name: "all",
    params: ["list"],
    returns: "boolean",
    group: "list"
  },
  // Dates
  {
    name: "today",
    params: [],
    returns: "date",
    group: "date",
    contextual: true
  },
  {
    name: "date",
    params: ["text"],
    returns: "date",
    group: "date"
  },
  {
    name: "dateAdd",
    params: ["date", "amount", "unit"],
    returns: "date",
    group: "date"
  },
  {
    name: "dateDiff",
    params: ["from", "to", "unit"],
    returns: "number",
    group: "date"
  },
  {
    name: "year",
    params: ["date"],
    returns: "number",
    group: "date"
  },
  {
    name: "month",
    params: ["date"],
    returns: "number",
    group: "date"
  },
  {
    name: "day",
    params: ["date"],
    returns: "number",
    group: "date"
  },
  {
    name: "dayOfWeek",
    params: ["date"],
    returns: "number",
    feelName: "day of week",
    group: "date"
  },
  {
    name: "startOfMonth",
    params: ["date"],
    returns: "date",
    group: "date"
  },
  {
    name: "endOfMonth",
    params: ["date"],
    returns: "date",
    group: "date"
  },
  {
    name: "isWeekend",
    params: ["date"],
    returns: "boolean",
    group: "date"
  },
  {
    name: "age",
    params: ["dateOfBirth"],
    returns: "number",
    group: "date",
    contextual: true
  },
  // Scope
  {
    name: "rowIndex",
    params: [],
    returns: "number",
    group: "scope",
    contextual: true
  },
  {
    name: "rowCount",
    params: [],
    returns: "number",
    group: "scope",
    contextual: true
  }
] as const satisfies readonly FormulaFunctionRow[];

/** Every built-in name, for shape checks that ask whether a `call` names one. */
export const FORMULA_FUNCTION_NAMES: ReadonlySet<string> = new Set(
  FORMULA_FUNCTION_TABLE.map((row) => row.name)
);

function rowArity(row: FormulaFunctionRow): { min: number; max: number } {
  const required = row.params.filter((param) => !param.endsWith("?")).length;
  const min = row.min ?? (row.variadic ? 0 : required);
  return { min, max: row.variadic ? Number.POSITIVE_INFINITY : row.params.length };
}

/** The argument count a built-in accepts, or `undefined` for a name the table lacks. */
export function formulaFunctionArity(name: string): { min: number; max: number } | undefined {
  const row = FORMULA_FUNCTION_TABLE.find((entry) => entry.name === name);
  return row === undefined ? undefined : rowArity(row);
}

/**
 * The names and arities the parser checks calls against, as fresh plain data (a host may add
 * its plugins' functions before handing the list on).
 */
export function formulaFunctionSignatures(): Array<{ name: string; min: number; max: number }> {
  return FORMULA_FUNCTION_TABLE.map((row) => ({ name: row.name, ...rowArity(row) }));
}
