/**
 * The formula builder's eager pieces about functions and names: the function table the core
 * keeps (`core/expressions/function-table.ts`) merged with its words (`function-docs.ts`) and
 * the builder's own additions per row (the group's text key, a signature line, a snippet with
 * blanks), the plugin functions a host wired joined to it as one table, the spelling of an id a
 * formula can take (`feelName`), and the Helpers menu's snippets.
 *
 * Small and dependency-light on purpose: the Logic workspace, the inspector and the Variables
 * panel read it eagerly; the CodeMirror editor (a lazy chunk) reads it too. Nothing here is
 * kernel-shaped; the kernel receives the signatures as an argument.
 */
import {
  FORMULA_FUNCTION_TABLE,
  formulaFunctionSignatures,
  type FormulaFunctionGroup,
  type FormulaFunctionRow as CoreFunctionRow,
  type FormulaReturnKind
} from "../../core/expressions/function-table.js";
import { FORMULA_FUNCTION_DOCS } from "../../core/expressions/function-docs.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import type { FormulaFunctionTableRow } from "../../registry/formula-functions/formula-function-registry.js";
import { builderText, type BuilderTextKey, type BuilderTextOptions } from "../logic/builder-texts.js";

export {
  FORMULA_FUNCTION_NAMES,
  FORMULA_FUNCTION_TABLE,
  formulaFunctionArity,
  formulaFunctionSignatures
} from "../../core/expressions/function-table.js";
export type { FormulaFunctionGroup, FormulaReturnKind } from "../../core/expressions/function-table.js";

/** One function as the builder shows it: the core row, its words and the builder's additions. */
export interface FormulaFunctionRow {
  readonly name: string;
  /** Parameter names in order; an optional one ends in `?`, a variadic row repeats its last. */
  readonly params: readonly string[];
  readonly variadic?: true;
  readonly min?: number;
  readonly returns: FormulaReturnKind;
  /** The core's group, or `plugin` for a function a plugin contributed. */
  readonly group: FormulaFunctionGroup | "plugin";
  /** The catalog key of the group's heading (`fn.group.text`). */
  readonly groupKey: BuilderTextKey;
  readonly summary: string;
  readonly example: string;
  /** The call as the function list shows it: `substring(text, start, length?)`. */
  readonly signature: string;
  /** The call with `${n}` blanks for the editor to select in turn: `substring(${1}, ${2})`. */
  readonly snippet: string;
  /** The DMN FEEL spelling when it differs from `name`. */
  readonly feelName?: string;
  /** Reads the evaluation context (the day, the row position), not only its arguments. */
  readonly contextual?: true;
  /** The plugin that contributed the function. */
  readonly plugin?: string;
  /** Insertions the plugin offers for the function, joining the Helpers menu. */
  readonly snippets?: ReadonlyArray<{ label: string; insert: string }>;
}

/** The names the grammar reserves; a field spelt like one needs backticks. */
const KEYWORDS: ReadonlySet<string> = new Set(["if", "then", "else", "and", "or", "not", "between", "in", "true", "false", "null"]);

const BARE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*$/;

/** Whether the grammar reads `id` as one plain name: letters, digits and underscores with glued `-` or `.` segments, and not a keyword. */
export function isBareFormulaName(id: string): boolean {
  return BARE_NAME.test(id) && !KEYWORDS.has(id);
}

/**
 * `id` as a formula spells it: bare when the grammar takes it so, else in backticks. An id the
 * grammar cannot take even in backticks (one holding a backtick, or blank at either end, which
 * the parser trims) is returned backticked all the same; the parser then reports it.
 */
export function feelName(id: string): string {
  return isBareFormulaName(id) ? id : "`" + id + "`";
}

/** The call as the function list shows it: the name and its parameters, optional ones with their `?`. */
function signatureOf(name: string, params: readonly string[], variadic: boolean | undefined): string {
  const list = variadic ? [...params.slice(0, -1), `${params[params.length - 1] ?? "value"}…`] : [...params];
  return `${name}(${list.join(", ")})`;
}

/** The call with a `${n}` blank per required parameter (one for a variadic row), none for a row without parameters. */
function snippetOf(name: string, params: readonly string[], variadic: boolean | undefined, min: number | undefined): string {
  let required = params.filter((param) => !param.endsWith("?")).length;
  if (variadic) {
    // A variadic call offers one blank even when it accepts none (`sum()` is rarely meant).
    required = Math.max(1, min ?? 1);
  } else if (min !== undefined) {
    required = Math.max(min, required);
  }
  const blanks: string[] = [];
  for (let at = 1; at <= required; at += 1) {
    blanks.push("${" + String(at) + "}");
  }
  return `${name}(${blanks.join(", ")})`;
}

function groupKeyOf(group: FormulaFunctionGroup | "plugin"): BuilderTextKey {
  return `fn.group.${group}` as BuilderTextKey;
}

function builtInRow(row: CoreFunctionRow): FormulaFunctionRow {
  const doc = FORMULA_FUNCTION_DOCS[row.name];
  const merged: {
    -readonly [K in keyof FormulaFunctionRow]: FormulaFunctionRow[K];
  } = {
    name: row.name,
    params: row.params,
    returns: row.returns,
    group: row.group,
    groupKey: groupKeyOf(row.group),
    summary: doc?.summary ?? "",
    example: doc?.example ?? `${row.name}()`,
    signature: signatureOf(row.name, row.params, row.variadic),
    snippet: snippetOf(row.name, row.params, row.variadic, row.min)
  };
  if (row.variadic) merged.variadic = true;
  if (row.min !== undefined) merged.min = row.min;
  if (row.feelName !== undefined) merged.feelName = row.feelName;
  if (row.contextual) merged.contextual = true;
  return merged;
}

function pluginRow(row: FormulaFunctionTableRow): FormulaFunctionRow {
  const merged: {
    -readonly [K in keyof FormulaFunctionRow]: FormulaFunctionRow[K];
  } = {
    name: row.name,
    params: row.params,
    returns: row.returns,
    group: "plugin",
    groupKey: groupKeyOf("plugin"),
    summary: row.summary,
    example: row.example,
    signature: signatureOf(row.name, row.params, row.variadic),
    snippet: snippetOf(row.name, row.params, row.variadic, row.min),
    plugin: row.plugin
  };
  if (row.variadic) merged.variadic = true;
  if (row.min !== undefined) merged.min = row.min;
  if (row.snippets !== undefined) merged.snippets = row.snippets.map((snippet) => ({ ...snippet }));
  return merged;
}

/** Every built-in as the builder shows it, in the table's order (grouped: logic, text, numbers, lists, dates, scope). */
export const FORMULA_FUNCTION_ROWS: readonly FormulaFunctionRow[] = FORMULA_FUNCTION_TABLE.map((row) => builtInRow(row));

/** Where plugin rows come from: the host's `FormulaFunctionRegistry`, or its `table()` already read. */
export type FormulaFunctionTableSource = { table(): readonly FormulaFunctionTableRow[] } | readonly FormulaFunctionTableRow[];

/** The built-ins followed by the plugin functions the host wired, as one table in a fresh array. */
export function formulaFunctionRows(registry?: FormulaFunctionTableSource): FormulaFunctionRow[] {
  const rows = [...FORMULA_FUNCTION_ROWS];
  if (registry === undefined) {
    return rows;
  }
  const pluginRows = Array.isArray(registry) ? registry : (registry as { table(): readonly FormulaFunctionTableRow[] }).table();
  for (const row of pluginRows) {
    rows.push(pluginRow(row));
  }
  return rows;
}

/** The signatures the parser checks calls against: the built-ins followed by the plugin functions the host wired. */
export function formulaSignatures(registry?: { signatures(): FormulaFunctionSignature[] }): FormulaFunctionSignature[] {
  const signatures = formulaFunctionSignatures();
  if (registry !== undefined) {
    signatures.push(...registry.signatures());
  }
  return signatures;
}

/** The row `name` calls, among `rows` (default: the built-ins). */
export function functionRowByName(name: string, rows: readonly FormulaFunctionRow[] = FORMULA_FUNCTION_ROWS): FormulaFunctionRow | undefined {
  return rows.find((row) => row.name === name);
}

// --- the Helpers menu ---------------------------------------------------------------------------

export type FormulaSnippetGroup = "answers" | "choices" | "dates" | "cases" | "plugin";

/**
 * One entry of the Helpers menu. `insert` holds `${1}`-style blanks the editor turns into
 * selections in order (Tab cycles); `blanks` names each in that order, the placeholder the
 * editor shows while a blank is unfilled. A plugin snippet has a `label` instead of a key.
 */
export interface FormulaSnippet {
  readonly id: string;
  readonly group: FormulaSnippetGroup;
  readonly labelKey: BuilderTextKey;
  readonly label?: string;
  readonly insert: string;
  readonly blanks: readonly string[];
  /** The piece as the menu previews it, blanks as `…`. */
  readonly preview: string;
}

const BLANK = /\$\{(\d+)\}/g;

/** How many distinct `${n}` blanks `insert` holds. */
export function snippetBlanks(insert: string): number {
  const seen = new Set<string>();
  for (const match of insert.matchAll(BLANK)) {
    seen.add(match[1] as string);
  }
  return seen.size;
}

/** `insert` with every blank as `…`, for the menu's preview. */
function previewOf(insert: string): string {
  return insert.replace(BLANK, "…").replace(/\s*\n\s*/g, " ");
}

function snippet(id: string, group: FormulaSnippetGroup, insert: string, blanks: readonly string[], preview?: string): FormulaSnippet {
  return { id, group, labelKey: `snippet.${id}` as BuilderTextKey, insert, blanks, preview: preview ?? previewOf(insert) };
}

/** The Helpers menu's groups in order, with the catalog key of each heading. */
export const FORMULA_SNIPPET_GROUPS: ReadonlyArray<{ id: FormulaSnippetGroup; labelKey: BuilderTextKey }> = [
  { id: "answers", labelKey: "snippet.group.answers" },
  { id: "choices", labelKey: "snippet.group.choices" },
  { id: "dates", labelKey: "snippet.group.dates" },
  { id: "cases", labelKey: "snippet.group.cases" },
  { id: "plugin", labelKey: "snippet.group.plugin" }
];

/** The built-in Helpers menu. */
export const FORMULA_SNIPPETS: readonly FormulaSnippet[] = [
  snippet("isAnswered", "answers", "not(empty(${1}))", ["field"]),
  snippet("isEmpty", "answers", "empty(${1})", ["field"]),
  snippet("anyOf", "answers", "${1} in (${2}, ${3})", ["field", "a", "b"], "… in (a, b)"),
  snippet("between", "answers", "${1} between ${2} and ${3}", ["field", "a", "b"], "… between a and b"),
  snippet("allTicked", "choices", "${1} and ${2}", ["box", "box"]),
  snippet("anyTicked", "choices", "${1} or ${2}", ["box", "box"]),
  snippet("noneTicked", "choices", "not(${1} or ${2})", ["box", "box"]),
  snippet("atLeastTicked", "choices", "count(selected(${1})) >= ${2}", ["group", "N"], "count(selected(…)) >= N"),
  snippet("withinDays", "dates", '${1} >= dateAdd(today(), -${2}, "days")', ["date", "N"], '… >= dateAdd(today(), -N, "days")'),
  snippet("beforeDate", "dates", '${1} < @"${2}"', ["date", "2026-01-01"], '… < @"2026-01-01"'),
  snippet("ageAtLeast", "dates", "age(${1}) >= ${2}", ["date of birth", "N"], "age(…) >= N"),
  snippet("weekend", "dates", "isWeekend(${1})", ["date"]),
  snippet("ifThenElse", "cases", "if ${1} then ${2} else ${3}", ["condition", "value", "value"], "if a then x else y"),
  snippet("cases", "cases", "if ${1}\n  then ${2}\nelse if ${3}\n  then ${4}\nelse ${5}", ["condition", "value", "condition", "value", "value"], "if … else if … else")
];

/** The snippets plugin functions declared (`FormulaFunctionContribution.snippets`), from the merged rows. */
export function pluginSnippets(rows: readonly FormulaFunctionRow[]): FormulaSnippet[] {
  const result: FormulaSnippet[] = [];
  for (const row of rows) {
    if (row.plugin === undefined || row.snippets === undefined) {
      continue;
    }
    row.snippets.forEach((entry, index) => {
      const blanks: string[] = [];
      for (let at = 0; at < snippetBlanks(entry.insert); at += 1) {
        blanks.push("value");
      }
      result.push({
        id: `${row.plugin}.${row.name}.${String(index)}`,
        group: "plugin",
        labelKey: "snippet.group.plugin",
        label: entry.label,
        insert: entry.insert,
        blanks,
        preview: previewOf(entry.insert)
      });
    });
  }
  return result;
}

/** A snippet's label in the locale: its own for a plugin's, else its catalog key's text. */
export function snippetLabel(entry: FormulaSnippet, options?: BuilderTextOptions): string {
  return entry.label ?? builderText(entry.labelKey, undefined, options);
}
