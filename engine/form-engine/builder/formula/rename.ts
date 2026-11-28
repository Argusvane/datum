/**
 * The rename seam for formulas: when a component's id changes, every rule that reads it
 * follows. A formula string is rewritten in place over the parser's `paths` spans, so the
 * author's spacing, quotes, comments-by-layout and case ladder stay as written; the object form
 * has its `formula` renamed. The builder's `formRenamed` seams call this for component rules,
 * journey `when` and PDF layout `when`.
 *
 * A path follows the rename when its field segment is `from`: the bare id (`amount`), a value
 * under it (`address.city` → `home.city`), and the entry and ancestor scopes (`row.amount`,
 * `ancestor.amount`). `host.` and `component` paths name no field and never change.
 */
import { isScopedExpressionPath } from "../../core/expressions/condition-shape.js";
import type { RuleSource } from "../../core/expressions/expression.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaFunctionSignature, FormulaParseResult } from "../../core/expressions/formula-types.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { feelName } from "./feel-functions.js";

/** Whether `path` names the field `from`: the path a rename from `from` would rewrite. */
export function pathNamesField(path: string, from: string): boolean {
  return from !== "" && renameFormulaPath(path, from, from + "_") !== path;
}

/** `path` with its field segment `from` replaced by `to`; `path` itself when it names another field. */
export function renameFormulaPath(path: string, from: string, to: string): string {
  return renamePathIn(path, from, to, ENTRY_SCOPES);
}

/** The scopes that lead into an entry or an ancestor, where a path's next segment names a field. */
const ENTRY_SCOPES: readonly string[] = ["row.", "ancestor."];

/** {@link renameFormulaPath}, following the field into the given entry scopes only. */
function renamePathIn(path: string, from: string, to: string, scopes: readonly string[]): string {
  if (from === "" || from === to) {
    return path;
  }
  // A scope read names no field of its own: `host.role` and `component` are the host's and the
  // component's, and `row.`/`ancestor.` lead into the entry or the ancestor, so a field whose id
  // spells one of those words (`host`, `row`) is not what they read.
  if (isScopedExpressionPath(path)) {
    for (const scope of scopes) {
      if (path.startsWith(scope)) {
        const rest = path.slice(scope.length);
        if (rest === from) {
          return scope + to;
        }
        if (rest.startsWith(from + ".")) {
          return scope + to + rest.slice(from.length);
        }
      }
    }
    return path;
  }
  if (path === from) {
    return to;
  }
  if (path.startsWith(from + ".") || path.startsWith(from + "[")) {
    return to + path.slice(from.length);
  }
  return path;
}

/** Where a renamed component's data went: its data path before and after, with `[]` for a repeating section's entries. */
export interface ValuePathMove {
  from: string;
  to: string;
}

/**
 * Where data went: one move (a rename's), or every move one edit made (two data keys swapped,
 * a grid's key and a row field's key changed together).
 */
export type ValuePathMoves = ValuePathMove | readonly ValuePathMove[];

/**
 * A path that reads answers (a PDF template's `path` source, a generated layout's collection path)
 * after a rename: by the move of the data when the rename carries one (`applicant.email` to
 * `applicant.mail`, which a leading-name rename cannot see), else as {@link renameFormulaPath}
 * does, the id being the data path.
 */
export function renameAnswerPath(path: string, from: string, to: string, dataPath?: ValuePathMoves): string {
  return dataPath === undefined ? renameFormulaPath(path, from, to) : moveValuePath(path, dataPath);
}

/**
 * A value path after the moves of one edit, applied as one map: the path follows the most
 * specific move that reaches it (the longest `from`: a row field's own move over its grid's)
 * and is never handed on to the next move, so two keys swapped stay swapped.
 */
export function moveValuePath(path: string, moves: ValuePathMoves): string {
  const list: readonly ValuePathMove[] = Array.isArray(moves) ? moves : [moves as ValuePathMove];
  let best: ValuePathMove | undefined;
  let moved = path;
  for (const move of list) {
    const next = renameValuePathByMove(path, move);
    if (next !== path && (best === undefined || move.from.length > best.from.length)) {
      best = move;
      moved = next;
    }
  }
  return moved;
}

/**
 * A move of a grid row field's data (`items[].sku` to `items[].code`) read as a move of its key
 * within the row, which is how a rule inside the row (`row.sku`) and a scenario's `add row`
 * name it. The key is the path past the innermost `[]` (`address.city` under a data-scoping
 * container); `collection` is the row's collection after the move, `collectionBefore` the one
 * before, which differ when the grid's own key changed in the same edit. `undefined` for a move
 * outside a row, or one that leaves or enters a row.
 */
export function rowKeyMoveOf(move: ValuePathMove): { collection: string; collectionBefore: string; from: string; to: string } | undefined {
  const at = move.from.lastIndexOf("[].");
  const atTo = move.to.lastIndexOf("[].");
  if (at < 0 || atTo < 0) {
    return undefined;
  }
  const from = move.from.slice(at + 3);
  const to = move.to.slice(atTo + 3);
  return from.includes("[") || to.includes("[") ? undefined : { collection: move.to.slice(0, atTo), collectionBefore: move.from.slice(0, at), from, to };
}

/**
 * A value path (`items[0].sku`, `applicant.email`: how a template source or a generated
 * binding reaches an answer) after the data at `move.from` moved to `move.to`. The path follows
 * only when it starts with the old data path at a segment boundary, an entry index (`[0]`)
 * read as `[]`, and keeps its own indexes. This is the move of the data itself, not a rename of
 * every segment spelling the id: a field with its own data key, or a section with its own
 * collection path, does not move when its id changes, and a segment can spell an id by accident.
 */
export function renameValuePathByMove(path: string, move: ValuePathMove): string {
  const { from, to } = move;
  if (from === "" || from === to) {
    return path;
  }
  // Walk `path` and `from` together; an entry index in the path stands for `[]` in the data path.
  const indexes: string[] = [];
  let at = 0;
  let matched = 0;
  while (matched < from.length) {
    const bracket = /^\[\d+\]/.exec(path.slice(at));
    if (bracket && from.startsWith("[]", matched)) {
      indexes.push(bracket[0]);
      at += bracket[0].length;
      matched += 2;
    } else if (path[at] === from[matched] && path[at] !== undefined) {
      at += 1;
      matched += 1;
    } else {
      return path;
    }
  }
  const rest = path.slice(at);
  if (rest !== "" && !rest.startsWith(".") && !rest.startsWith("[")) {
    return path;
  }
  // The new data path takes the entry indexes the old one read, in order.
  let used = 0;
  const head = to.replace(/\[\]/g, () => indexes[used++] ?? "[]");
  return head + rest;
}

/**
 * Parse `text` for its paths, tolerating calls to functions the signatures lack: a rename must
 * reach a formula that calls a plugin function the builder has not been told about, so an
 * `unknownFunction` error adds that name (any arity) to a copy of the signatures and parses
 * again. Bounded by the number of distinct names in the text.
 */
function parseForRename(text: string, signatures: readonly FormulaFunctionSignature[]): FormulaParseResult {
  let known: FormulaFunctionSignature[] = [...signatures];
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const result = kernelParseFormula(text, known);
    if (result.ok || result.code !== "unknownFunction" || typeof result.params.name !== "string") {
      return result;
    }
    const name = result.params.name;
    if (known.some((signature) => signature.name === name)) {
      return result;
    }
    known = [...known, { name, min: 0, max: Number.POSITIVE_INFINITY }];
  }
  return kernelParseFormula(text, known);
}

/**
 * `text` with every path that names `from` renamed to `to`, the rest byte for byte. A formula
 * that does not parse is returned as it is: there is no span to trust. `signatures` defaults
 * to the built-ins; unknown functions do not stop the rename (see {@link parseForRename}).
 */
export function renamePathsInFormula(
  text: string,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): string {
  if (from === "" || from === to) {
    return text;
  }
  return mapPathsInFormula(text, (path) => renameFormulaPath(path, from, to), signatures);
}

/** `text` with every path `map` changes written as it says, the rest byte for byte; as it is when it does not parse. */
function mapPathsInFormula(text: string, map: (path: string) => string, signatures: readonly FormulaFunctionSignature[]): string {
  if (text === "") {
    return text;
  }
  const parsed = parseForRename(text, signatures);
  if (!parsed.ok) {
    return text;
  }
  const edits = parsed.paths
    .map((ref) => ({ ref, path: map(ref.path) }))
    .filter((edit) => edit.path !== edit.ref.path)
    .sort((a, b) => b.ref.start - a.ref.start);
  if (edits.length === 0) {
    return text;
  }
  let result = text;
  for (const edit of edits) {
    result = result.slice(0, edit.ref.start) + feelName(edit.path) + result.slice(edit.ref.end);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored rule with `from` renamed to `to`: a formula string through
 * {@link renamePathsInFormula}, the object form through its `formula`. The same reference comes
 * back when nothing changed, so
 * a caller can tell an untouched rule apart and keep it byte for byte.
 */
export function renameInRuleSource<T extends RuleSource | unknown>(
  source: T,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): T {
  if (from === "" || from === to) {
    return source;
  }
  return mapRuleSourcePaths(source, (path) => renameFormulaPath(path, from, to), signatures);
}

/**
 * {@link renameInRuleSource} for a component's own id, with the reads of a grid row's keys
 * (`row.sku`) left as they are: the row scope reads by data key, which a field
 * keeps when it has one of its own, so those reads follow the keys that moved
 * ({@link renameRowKeysInRuleSource}), never the id.
 */
export function renameIdInRuleSource<T extends RuleSource | unknown>(
  source: T,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): T {
  if (from === "" || from === to) {
    return source;
  }
  return mapRuleSourcePaths(source, (path) => renamePathIn(path, from, to, ["ancestor."]), signatures);
}

/**
 * A stored rule with each read of a grid row's key (`row.sku`, `row.sku.x`, `row.address.city`)
 * reading the key it moved to: a row field's data key or id changed (the row scope
 * reads by key), and the rules inside the row follow it. The keys of one edit are applied as one
 * map, each read once by the most specific key that reaches it, so two keys swapped stay
 * swapped. Nothing else is touched; the same reference comes back when nothing changed.
 */
export function renameRowKeysInRuleSource<T extends RuleSource | unknown>(
  source: T,
  keys: readonly { readonly from: string; readonly to: string }[],
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): T {
  const scope = "row.";
  const moved = keys.filter((key) => key.from !== "" && key.from !== key.to);
  if (moved.length === 0) {
    return source;
  }
  const map = (path: string): string => {
    if (!path.startsWith(scope)) {
      return path;
    }
    let key: { readonly from: string; readonly to: string } | undefined;
    for (const entry of moved) {
      const reads = path === scope + entry.from || path.startsWith(scope + entry.from + ".") || path.startsWith(scope + entry.from + "[");
      if (reads && (key === undefined || entry.from.length > key.from.length)) {
        key = entry;
      }
    }
    return key === undefined ? path : scope + key.to + path.slice(scope.length + key.from.length);
  };
  return mapRuleSourcePaths(source, map, signatures);
}

/** {@link renameInRuleSource} over any path rewrite `map`: a formula that does not parse stays as written. */
export function mapRuleSourcePaths<T>(source: T, map: (path: string) => string, signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()): T {
  if (typeof source === "string") {
    return mapPathsInFormula(source, map, signatures) as T;
  }
  if (!isRecord(source) || typeof source.formula !== "string") {
    return source;
  }
  const formula = mapPathsInFormula(source.formula, map, signatures);
  return formula !== source.formula ? ({ ...source, formula } as T) : source;
}

/** Whether the formula `text` reads the field `from` in any form a rename would follow; false for text that does not parse. */
export function formulaReadsField(
  text: string,
  from: string,
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): boolean {
  if (from === "" || text === "") {
    return false;
  }
  const parsed = parseForRename(text, signatures);
  return parsed.ok && parsed.paths.some((ref) => pathNamesField(ref.path, from));
}

/**
 * Whether `text` spells the id `from` as a word (bare, or in backticks) anywhere, strings
 * included: a lexical look for a formula the parser rejects, where there is no span to trust
 * and a rename cannot follow. A rename reports such a formula as left as written.
 */
export function formulaMentionsField(text: string, from: string): boolean {
  if (from === "" || text === "") {
    return false;
  }
  if (text.includes("`" + from + "`")) {
    return true;
  }
  let at = text.indexOf(from);
  while (at >= 0) {
    const before = at === 0 ? "" : text[at - 1]!;
    const after = text[at + from.length] ?? "";
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
      return true;
    }
    at = text.indexOf(from, at + 1);
  }
  return false;
}

/**
 * The formula text of a stored rule (a string, or the object form's `formula`) that the
 * parser rejects while it spells `from`: what {@link renameInRuleSource} had to leave as
 * written, for the rename to report. `undefined` when the rule parses, holds no formula text,
 * or never names the field.
 */
export function unparsedFormulaNaming(
  source: unknown,
  from: string,
  signatures: readonly FormulaFunctionSignature[] = formulaFunctionSignatures()
): string | undefined {
  const text = typeof source === "string" ? source : isRecord(source) && typeof source.formula === "string" ? source.formula : undefined;
  if (text === undefined || text === "" || from === "" || !formulaMentionsField(text, from)) {
    return undefined;
  }
  return parseForRename(text, signatures).ok ? undefined : text;
}
