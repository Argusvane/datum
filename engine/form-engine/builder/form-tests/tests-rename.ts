/**
 * Following a component's rename into the form's tests. A test
 * names fields by their value path (`total`, `items[0].qty`), and a rename of a component's id
 * moves the segment that names it; the shell calls {@link renameInTests} after a controller
 * `change` carrying `renamed`, and stores what it returns in the rename's own step of the
 * history (`BuilderController.followRename`), so one Undo takes the id and the tests back.
 *
 * The rewriting is the parser's, never a text search: each source is parsed alone and the
 * references it records (`FormTestRef`, with their spans) say where a name sits, so a `"total"`
 * inside a string, a comment, or a page called `total` is never touched. A source that does not
 * parse is left as it is (its references are not trustworthy), and the other entries still change.
 *
 * The segment rules, from the value-path grammar (`core/tree/data-scope.ts`: a path is the
 * segments of the data containers around a field, then the field's own, and a repeating
 * section's rows add `[n]` after the collection's segment):
 * - a `path` ref (`set`, `clear`, every `expect`, a read inside `expect <formula>`), a
 *   `collection` ref (`add row to items`, `remove row 0 of items`, `rows of items`) and a
 *   `rowKey` ref (the `qty` of `add row to items with qty = 2`, relative to the new row) are
 *   dotted segments, each optionally followed by `[n]` indices;
 * - a segment equal to the old id becomes the new one, wherever it sits in the path: the lead
 *   (`items` in `items[0].qty`), a data container's (`applicant` in `applicant.email`) or the
 *   field's own (`qty` after `[0].`). Component ids are unique across a form, so a segment that
 *   spells the old id names that component; the one exception is a data key that
 *   happens to spell it, which the author finds with the next run;
 * - the digits inside `[ ]` are positions, never names, and a `host` ref (`host.role`) is the
 *   host's key, a `page`, `journey`, `layout` or `code` ref is another namespace: none of them
 *   follow a component's rename (a page or journey id is followed by its own call, below);
 * - a formula read keeps the backticks round it: the parser's span is the name inside them, and
 *   a backticked name that is the whole old id is replaced whole, spaces and dots included.
 * Edits are applied back to front per source, so one rewrite never moves the next one's span.
 *
 * Pages and journeys: the journeys mode announces a page node's rename (a page id is
 * the journey's own node id) and the shell calls {@link renameInTests} with
 * `kind: "page"`; `kind: "journey"` follows a journey id the same way. These ids are whole
 * bare tokens in the language, never dotted paths, so a rename replaces a ref only when its
 * whole text equals the old id: a field that happens to share the page's id stays (a page id
 * is no value path), and a `page` rename never reaches a `set` line. The one `page` ref that
 * is not a page is the exit of `expect path ends at stop`: the parser records it as a page
 * ref because it reads an id, but an exit is the journey's own and is renamed (if ever) by
 * the exit's own designer, so it is skipped by the line of its step. Layout ids never change
 * (the designer renames the label), so there is no `"layout"` kind.
 */
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { kernelFormTestIsId, kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import { readFormTests } from "../../core/form-tests/form-test-read.js";
import type { FormTestConfiguration, FormTestRef, FormTestScenario } from "../../core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { moveValuePath, rowKeyMoveOf, type ValuePathMove } from "../formula/rename.js";

/** The ref kinds that name a component's value path (or a key inside one). */
const PATH_KINDS: ReadonlySet<FormTestRef["kind"]> = new Set(["path", "collection", "rowKey"]);

/** Characters of one path segment, as the language reads them. */
function isSegmentChar(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

/**
 * `text` with every segment equal to `from` replaced by `to`, or `undefined` when none was.
 * Bracketed positions (`[0]`) are skipped whole.
 */
function renameSegments(text: string, from: string, to: string): string | undefined {
  if (text === from) {
    return to;
  }
  let out = "";
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "[") {
      const close = text.indexOf("]", i);
      const end = close < 0 ? text.length : close + 1;
      out += text.slice(i, end);
      i = end;
    } else if (isSegmentChar(ch)) {
      let j = i + 1;
      while (j < text.length && isSegmentChar(text.charAt(j))) {
        j += 1;
      }
      const segment = text.slice(i, j);
      if (segment === from) {
        out += to;
        changed = true;
      } else {
        out += segment;
      }
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return changed ? out : undefined;
}

/** What a rename follows: a component's value path, a journey page's id, or a journey's id. */
export type TestsRenameKind = "path" | "page" | "journey";

/** The lines of the scenario's `expect path ends at <exit>` steps: their page ref is an exit, not a page. */
function pathEndLines(scenario: FormTestScenario): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const step of scenario.steps) {
    if (step.kind === "expectPathEnd" && step.exit !== undefined) {
      lines.add(step.line);
    }
  }
  return lines;
}

/** What a rename may change beside `kind`: for a page, the journey it is a page of. */
export interface TestsRenameOptions {
  kind?: TestsRenameKind;
  /**
   * For `kind: "page"`: the journey whose page was renamed. Page ids are per journey (two
   * journeys may each have a `details` page), so only the scenarios that run this journey
   * follow it: their `given journey`, else `defaultJourneyId`. Absent, every scenario
   * follows, as before.
   */
  journeyId?: string;
  /** The journey a scenario with no `given journey` runs (the definition's default, else its first); absent, such a scenario follows. */
  defaultJourneyId?: string;
}

/** Whether a `page` rename in `journeyId` reaches the scenario: it runs that journey, as coverage reads it (`coversRule`). */
function runsJourney(scenario: FormTestScenario, options: TestsRenameOptions): boolean {
  if (options.journeyId === undefined) {
    return true;
  }
  const given = scenario.givens.find((entry) => entry.kind === "given" && entry.key === "journey");
  const used = given !== undefined && given.kind === "given" && given.key === "journey" ? given.value : options.defaultJourneyId;
  return used === undefined || used === options.journeyId;
}

/** One source with the old id renamed, or `undefined` when it does not parse or names nothing to change. */
function renameInSource(
  source: string,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[],
  kind: TestsRenameKind,
  options: TestsRenameOptions
): string | undefined {
  const parsed = kernelParseFormTests(source, signatures);
  if (parsed.problems.length > 0) {
    return undefined;
  }
  const edits = new Map<number, { start: number; end: number; text: string }>();
  for (const scenario of parsed.scenarios) {
    if (kind === "page" && !runsJourney(scenario, options)) {
      continue;
    }
    const exits = kind === "page" ? pathEndLines(scenario) : new Set<number>();
    for (const ref of scenario.refs) {
      // The source's own slice, not the ref's text: it is what the span covers, whatever the
      // parser normalised on the way.
      const current = source.slice(ref.span.start, ref.span.end);
      let next: string | undefined;
      if (kind === "path") {
        if (!PATH_KINDS.has(ref.kind)) {
          continue;
        }
        next = renameSegments(current, from, to);
      } else {
        // Whole-token match: these ids carry no segments. A new id the language could not read
        // back as one token would break the source, so such a rename leaves the tests alone.
        if (ref.kind !== kind || current !== from || !kernelFormTestIsId(to) || exits.has(ref.span.line)) {
          continue;
        }
        next = to;
      }
      if (next !== undefined && next !== current) {
        edits.set(ref.span.start, { start: ref.span.start, end: ref.span.end, text: next });
      }
    }
  }
  if (edits.size === 0) {
    return undefined;
  }
  let result = source;
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * The `tests` block with `from` renamed `to` in every scenario, or `undefined` when no entry
 * changed (so the shell stores nothing and spends no undo step). `options.kind` says what
 * `from` names: a component (`"path"`, the default), a
 * journey page (`"page"`, scoped to `options.journeyId` when given) or a journey (`"journey"`).
 */
export function renameInTests(
  tests: FormTestConfiguration | undefined,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[],
  options: TestsRenameOptions = {}
): FormTestConfiguration | undefined {
  const kind = options.kind ?? "path";
  if (tests === undefined || from === "" || to === "" || from === to) {
    return undefined;
  }
  const known = [...formulaFunctionSignatures(), ...signatures];
  // The entries as the definition's reader keeps them: a stored entry the reader would drop
  // (no id, a repeated id) is not the panel's, so it is not carried into the rewritten block.
  const entries = readFormTests({ tests });
  let changed = false;
  const scenarios = entries.map((entry) => {
    const source = renameInSource(entry.source, from, to, known, kind, options);
    if (source === undefined) {
      return entry;
    }
    changed = true;
    return { ...entry, source };
  });
  return changed ? { ...tests, scenarios } : undefined;
}

/**
 * The `tests` block with every value path that reads data moved by `moves` (a data key or a
 * container's key changed: `applicant.email` to `contact.email`, `items[].sku` to
 * `items[].code`) following the move, or `undefined` when no entry changed. A `path` or
 * `collection` ref follows by the move of the data (`moveValuePath`: an entry index in
 * the ref stands for `[]` and is kept); a `rowKey` ref (the `sku` of `add row to items with
 * sku = 1`) follows when its statement's collection, as written, is the one whose row key moved
 * (the grid's own key may have moved in the same edit, `items` to `lines`). A source
 * that does not parse is left as it is, as {@link renameInTests} leaves one.
 */
export function moveValuePathsInTests(
  tests: FormTestConfiguration | undefined,
  moves: readonly ValuePathMove[],
  signatures: readonly FormulaFunctionSignature[]
): FormTestConfiguration | undefined {
  const real = moves.filter((move) => move.from !== "" && move.from !== move.to);
  if (tests === undefined || real.length === 0) {
    return undefined;
  }
  const known = [...formulaFunctionSignatures(), ...signatures];
  let changed = false;
  const scenarios = readFormTests({ tests }).map((entry) => {
    const source = moveInSource(entry.source, real, known);
    if (source === undefined) {
      return entry;
    }
    changed = true;
    return { ...entry, source };
  });
  return changed ? { ...tests, scenarios } : undefined;
}

/** One source with `moves` followed, or `undefined` when it does not parse or reads none of them. */
function moveInSource(source: string, moves: readonly ValuePathMove[], signatures: readonly FormulaFunctionSignature[]): string | undefined {
  const parsed = kernelParseFormTests(source, signatures);
  if (parsed.problems.length > 0) {
    return undefined;
  }
  const keyMoves = moves.map(rowKeyMoveOf).filter((move): move is NonNullable<typeof move> => move !== undefined);
  const edits = new Map<number, { start: number; end: number; text: string }>();
  for (const scenario of parsed.scenarios) {
    // The collection each line's row keys belong to (`add row to items with …`).
    const collectionOfLine = new Map<number, string>();
    for (const ref of scenario.refs) {
      if (ref.kind === "collection") {
        collectionOfLine.set(ref.span.line, source.slice(ref.span.start, ref.span.end));
      }
    }
    for (const ref of scenario.refs) {
      const current = source.slice(ref.span.start, ref.span.end);
      let next = current;
      if (ref.kind === "path" || ref.kind === "collection") {
        // All of one edit's moves as one map: a path moves once, so two keys swapped stay swapped.
        next = moveValuePath(current, moves);
      } else if (ref.kind === "rowKey") {
        const collection = collectionOfLine.get(ref.span.line);
        // The line names the collection as it was written, before the move.
        const move = keyMoves.find((entry) => entry.collectionBefore === collection && entry.from === current);
        next = move?.to ?? current;
      }
      if (next !== current) {
        edits.set(ref.span.start, { start: ref.span.start, end: ref.span.end, text: next });
      }
    }
  }
  if (edits.size === 0) {
    return undefined;
  }
  let result = source;
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** A `given locale = "<value>"` statement: the value is a quoted string, in either kind of quote. */
const GIVEN_LOCALE = /^(\s*given\s+locale\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)')/i;

/** Where, in `source`, the quoted value of each `given locale` statement that names `code` starts and ends; `undefined` when the source does not parse. */
function localeGivens(source: string, code: string, signatures: readonly FormulaFunctionSignature[]): Array<{ start: number; end: number }> | undefined {
  const parsed = kernelParseFormTests(source, signatures);
  if (parsed.problems.length > 0) {
    return undefined;
  }
  const lines = source.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const found: Array<{ start: number; end: number }> = [];
  for (const scenario of parsed.scenarios) {
    for (const given of scenario.givens) {
      if (given.kind !== "given" || given.key !== "locale" || given.value !== code) {
        continue;
      }
      const text = lines[given.line - 1] ?? "";
      const match = GIVEN_LOCALE.exec(text);
      if (!match || (match[2] ?? match[3]) !== code) {
        continue;
      }
      const start = (offsets[given.line - 1] ?? 0) + match[1]!.length + 1;
      found.push({ start, end: start + code.length });
    }
  }
  return found;
}

/**
 * The `tests` block with the language `from` renamed `to` in every `given locale = "…"` of every
 * scenario, or `undefined` when no entry changed. A scenario sets its language with that
 * statement, and the driver refuses one the form does not declare, so a language renamed in the
 * Languages workspace would leave the scenarios that name it unable to start. Like
 * {@link renameInTests}, the parser finds the statement (a `"fr"` in a string or a comment is never
 * touched) and a source that does not parse is left as it is. The match is on the code as the
 * scenario spells it, and its quotes stay as they were.
 */
export function renameLocaleInTests(
  tests: FormTestConfiguration | undefined,
  from: string,
  to: string,
  signatures: readonly FormulaFunctionSignature[]
): FormTestConfiguration | undefined {
  if (tests === undefined || from === "" || to.trim() === "" || from === to || /["'\n\\]/.test(to)) {
    return undefined;
  }
  const known = [...formulaFunctionSignatures(), ...signatures];
  let changed = false;
  const scenarios = readFormTests({ tests }).map((entry) => {
    const spans = localeGivens(entry.source, from, known);
    if (spans === undefined || spans.length === 0) {
      return entry;
    }
    let source = entry.source;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      source = source.slice(0, span.start) + to + source.slice(span.end);
    }
    changed = true;
    return { ...entry, source };
  });
  return changed ? { ...tests, scenarios } : undefined;
}

/**
 * How many scenarios set the language `code` with `given locale`: what a removal of that
 * language would leave unable to start, for the question that asks before it goes.
 */
export function testsNamingLocale(tests: FormTestConfiguration | undefined, code: string, signatures: readonly FormulaFunctionSignature[] = []): number {
  if (tests === undefined || code === "") {
    return 0;
  }
  const known = [...formulaFunctionSignatures(), ...signatures];
  return readFormTests({ tests }).filter((entry) => (localeGivens(entry.source, code, known)?.length ?? 0) > 0).length;
}
