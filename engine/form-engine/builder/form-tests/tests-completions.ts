/**
 * What the test editor may suggest, in two halves that need no editor:
 *
 * - {@link createTestsCompletions} reads the form (its tree, journeys, PDF layouts and the host's
 *   validation codes) into the lists the editor offers. Pure and cheap, called when a list
 *   opens, so a field the author just added is there; nothing is cached.
 * - {@link testsSlotAt} reads the text of the line before the caret and says what may stand
 *   next (a field, a page, an error code, a value for the field it follows, a keyword). The
 *   CodeMirror source in `tests-editor.ts` turns a slot into the popover's options, and the
 *   tests drive the slot directly, so neither needs a layout engine.
 *
 * The language is line-based and its grammar is the parser's (`core/form-tests/form-test-parse.ts`):
 * the slot follows the same statement shapes word by word and never second-guesses a line the
 * parser would refuse; a line it cannot place offers nothing, which beats offering a wrong thing.
 * Keywords are English in every locale, so they are matched and offered as written;
 * the sentences that explain them are the editor's, from the catalog.
 *
 * A row field is offered as `items[0].qty`: the language needs an index, and the first row is the
 * one a short test usually means. The editor says so beside it.
 */
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { ENGINE_VALIDATION_CODES } from "../../core/localization/validation-messages.js";
import { readInlineOptions } from "../../core/schema/inline-options.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import { buildRowKeys, buildValuePaths, collectionPathOf, holdsData } from "../../core/tree/data-scope.js";
import { formulaFieldKind, type FormulaFieldKind } from "../formula/formula-fields.js";
import type { TestsCompletions } from "./tests-model.js";

// --- the lists -------------------------------------------------------------------------------

/** The lists, and the options of a choice field (so a value can be suggested for it). */
export interface TestsCompletionLists extends TestsCompletions {
  /** The inline options of a choice, checkbox group or multiple-choice field by value path; empty for any other. */
  optionsOf(path: string): ReadonlyArray<{ value: string; label: string }>;
  /** What the field stores, as the formula editor names it; `undefined` for a path the form lacks. */
  kindOf(path: string): FormulaFieldKind | undefined;
  /** Whether `path` is a repeating section or a data grid (its rows are what `rows of` counts). */
  isCollection(path: string): boolean;
}

interface FieldEntry {
  path: string;
  label: string;
  type: string;
  collection?: string;
  node: ComponentNode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A node's own name: its label, else its title, else its id; localized text read in `locale`. */
function nameOf(node: ComponentNode, locale: string): string {
  if (isRecord(node.configuration)) {
    for (const key of ["label", "title"]) {
      const raw = node.configuration[key];
      const text =
        typeof raw === "string" ? raw : isRecord(raw) ? resolveLocalizedText(raw as Parameters<typeof resolveLocalizedText>[0], locale) : undefined;
      if (text !== undefined && text.trim() !== "") {
        return text;
      }
    }
  }
  return node.id;
}

/**
 * Every component that carries an answer, in document order, by the path the language reads:
 * the value path for a field (data keys and data-scoping containers applied), the collection
 * path for a repeating section, and `collection[0].key` for a field inside a section's row.
 * Buttons, static HTML, images and grouping containers claim no data (`holdsData`), so they are
 * not offered.
 */
function fieldEntries(root: ComponentNode, locale: string): FieldEntry[] {
  const valuePaths = buildValuePaths(root);
  const rowKeys = buildRowKeys(root);
  const entries: FieldEntry[] = [];
  const seen = new Set<string>();
  const walk = (node: ComponentNode, within: string | undefined): void => {
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        if (!isRecord(child) || typeof child.id !== "string" || seen.has(child.id)) {
          continue;
        }
        seen.add(child.id);
        const own = collectionPathOf(child);
        let next = within;
        if (holdsData(child)) {
          if (own !== undefined) {
            entries.push({ path: own, label: nameOf(child, locale), type: child.type, node: child });
          } else if (within !== undefined) {
            const key = rowKeys.get(child.id) ?? child.id;
            entries.push({ path: `${within}[0].${key}`, label: nameOf(child, locale), type: child.type, collection: within, node: child });
          } else {
            entries.push({ path: valuePaths.get(child.id) ?? child.id, label: nameOf(child, locale), type: child.type, node: child });
          }
        }
        if (own !== undefined) {
          next = own;
        }
        walk(child, next);
      }
    }
  };
  walk(root, collectionPathOf(root));
  return entries;
}

/** The codes beyond the engine's own list that a test may still name. */
const EXTRA_CODES: readonly string[] = ["option.notAllowed"];

/**
 * The lists the editor offers, read from the form when asked. `definition` gives the journeys,
 * PDF layouts and default locale (it may be absent while the shell has no whole-definition
 * source; then only fields and codes are offered); `hostCodes` are the host's own validation
 * codes (`HostValidationCode.code`).
 */
export function createTestsCompletions(
  root: () => ComponentNode,
  definition: () => FormDefinition | undefined,
  hostCodes: () => readonly string[]
): TestsCompletionLists {
  const localeOf = (): string => definition()?.localization?.defaultLocale ?? "en";
  const entriesOf = (): FieldEntry[] => fieldEntries(root(), localeOf());
  const entryOf = (path: string): FieldEntry | undefined => entriesOf().find((entry) => entry.path === path);

  const journeys = (): NonNullable<NonNullable<FormDefinition["journey"]>["journeys"]> => definition()?.journey?.journeys ?? [];

  return {
    fields() {
      return entriesOf().map((entry) => ({
        path: entry.path,
        label: entry.label,
        type: entry.type,
        ...(entry.collection !== undefined ? { collection: entry.collection } : {})
      }));
    },
    pages() {
      const locale = localeOf();
      const names = new Map<string, string>();
      for (const entry of entriesOf()) {
        names.set(entry.node.id, entry.label);
      }
      const out: Array<{ id: string; label: string; journey: string }> = [];
      for (const journey of journeys()) {
        for (const page of journey.pages ?? []) {
          if (typeof page.id !== "string") {
            continue;
          }
          let label = resolveLocalizedText(page.title, locale);
          if (label === undefined || label.trim() === "") {
            const first = (page.components ?? []).find((component): component is string => typeof component === "string");
            label = first !== undefined ? (names.get(first) ?? page.id) : page.id;
          }
          out.push({ id: page.id, label, journey: journey.id });
        }
      }
      return out;
    },
    journeys() {
      const locale = localeOf();
      return journeys().map((journey) => ({ id: journey.id, label: resolveLocalizedText(journey.name, locale) ?? journey.id }));
    },
    layouts() {
      const locale = localeOf();
      return (definition()?.pdf?.layouts ?? []).map((layout) => ({ id: layout.id, label: resolveLocalizedText(layout.name, locale) ?? layout.id }));
    },
    codes() {
      const out: Array<{ code: string; label?: string }> = ENGINE_VALIDATION_CODES.map((entry) => ({ code: entry.code, label: entry.label }));
      const known = new Set(out.map((entry) => entry.code));
      for (const code of [...EXTRA_CODES, ...hostCodes()]) {
        if (typeof code === "string" && code !== "" && !known.has(code)) {
          known.add(code);
          out.push({ code });
        }
      }
      return out;
    },
    optionsOf(path) {
      const entry = entryOf(path);
      if (entry === undefined) {
        return [];
      }
      const kind = formulaFieldKind(entry.type);
      if (kind !== "choice" && kind !== "flags" && kind !== "list") {
        return [];
      }
      const locale = localeOf();
      return readInlineOptions(entry.node.configuration).map((option) => ({
        value: option.value,
        label: resolveLocalizedText(option.label, locale) ?? option.value
      }));
    },
    kindOf(path) {
      const entry = entryOf(path);
      if (entry === undefined) {
        return undefined;
      }
      return entry.node.collection !== undefined ? "list" : formulaFieldKind(entry.type);
    },
    isCollection(path) {
      const entry = entryOf(path);
      return entry !== undefined && (entry.node.collection !== undefined || entry.type === DATA_GRID_COMPONENT_TYPE);
    }
  };
}

/**
 * The lists in the shape the editor reads: a {@link TestsCompletions} that already is one passes
 * through, any other (a panel's own, a test's) gets the extras worked out from its fields, so
 * the editor takes the bare contract and nothing breaks for the lack of an option list.
 */
export function liftCompletions(completions: TestsCompletions | TestsCompletionLists): TestsCompletionLists {
  const lifted = completions as Partial<TestsCompletionLists> & TestsCompletions;
  if (typeof lifted.optionsOf === "function" && typeof lifted.kindOf === "function" && typeof lifted.isCollection === "function") {
    return completions as TestsCompletionLists;
  }
  const byPath = (path: string): ReturnType<TestsCompletions["fields"]>[number] | undefined => completions.fields().find((field) => field.path === path);
  return {
    fields: () => completions.fields(),
    pages: () => completions.pages(),
    journeys: () => completions.journeys(),
    layouts: () => completions.layouts(),
    codes: () => completions.codes(),
    optionsOf: lifted.optionsOf ?? (() => []),
    kindOf: lifted.kindOf ?? ((path) => {
      const field = byPath(path);
      return field === undefined ? undefined : formulaFieldKind(field.type);
    }),
    isCollection: lifted.isCollection ?? ((path) => {
      const field = byPath(path);
      return field !== undefined && (field.type === DATA_GRID_COMPONENT_TYPE || field.type === "repeatingSection" || completions.fields().some((other) => other.collection === path));
    })
  };
}

// --- the slot at the caret -------------------------------------------------------------------

/** What may stand at the caret. */
export type TestsSlotWants =
  | "statement"
  | "field"
  | "collection"
  | "rowKey"
  | "page"
  | "journey"
  | "layout"
  | "code"
  | "value"
  | "state"
  | "given";

/** A literal word (or phrase) that may stand at the caret, with the id the editor words it by. */
export interface TestsSlotWord {
  /** As typed: `error on`, `=`, `ends`. */
  text: string;
  /** The catalog's name for what it does (`expect.errorOn`, `stmt.set`); the editor maps it to a text. */
  id: string;
  /** The statement is complete with this word: nothing is inserted after it. */
  final?: boolean;
  /** Offered only after a page (`expect intro on path`) or only after a field. */
  after?: "page" | "field";
}

export interface TestsSlot {
  /** The characters already typed for the slot (inside a string: after its opening quote). */
  partial: string;
  /** The quote that is open at the caret (`"`, `'`, or `@"` for a date); only a value slot survives one. */
  quote?: string;
  wants: TestsSlotWants[];
  words: TestsSlotWord[];
  /** `wants` has `value`: the path of the field the value is for, when there is one (a `given host.x` has none). */
  field?: string | undefined;
  /** `wants` has `value`: the caret is inside a list (`("a", |`), so a value stands alone, not wrapped in a list. */
  list?: boolean;
  /** `wants` has `value`: what the value is for when not a field (`today`, `locale`, `options`). */
  given?: "today" | "locale" | "options";
  /** `wants` has `rowKey`: the collection whose row fields are offered. */
  collection?: string;
  /** `wants` has `state` or `words` that depend on it: the first word of an `expect`, which is a path or a page. */
  subject?: string;
}

interface Tok {
  text: string;
  kind: "word" | "sym" | "string";
}

interface Lexed {
  tokens: Tok[];
  partial: string;
  quote?: string;
  comment: boolean;
}

const WORD_CHAR = /[A-Za-z0-9_.\-[\]@]/;

function lower(text: string): string {
  return text.toLowerCase();
}

/**
 * The line before the caret as the parser would cut it: words (identifiers, paths, numbers),
 * symbols (`=`, `!=`, `:`, `(`, `)`, `,` and the formula operators), and whole strings. The
 * word that touches the caret is the `partial`, not a token; a string still open is the
 * `partial` too (its text after the quote) with the `quote` that opened it.
 */
function lexBefore(before: string): Lexed {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < before.length) {
    const ch = before.charAt(i);
    if (ch === " " || ch === "\t" || ch === " ") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      return { tokens, partial: "", comment: true };
    }
    const dated = ch === "@" && (before.charAt(i + 1) === '"' || before.charAt(i + 1) === "'");
    if (ch === '"' || ch === "'" || ch === "`" || dated) {
      const quote = dated ? before.charAt(i + 1) : ch;
      let j = i + (dated ? 2 : 1);
      while (j < before.length && before.charAt(j) !== quote) {
        j += before.charAt(j) === "\\" ? 2 : 1;
      }
      if (j >= before.length) {
        const opened = dated ? `@${quote}` : quote;
        return { tokens, partial: before.slice(i + opened.length), quote: opened, comment: false };
      }
      tokens.push({ text: before.slice(i, j + 1), kind: "string" });
      i = j + 1;
      continue;
    }
    if (ch === "!" && before.charAt(i + 1) === "=") {
      tokens.push({ text: "!=", kind: "sym" });
      i += 2;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i + 1;
      while (j < before.length && WORD_CHAR.test(before.charAt(j))) {
        j += 1;
      }
      const text = before.slice(i, j);
      if (j >= before.length) {
        return { tokens, partial: text, comment: false };
      }
      tokens.push({ text, kind: "word" });
      i = j;
      continue;
    }
    tokens.push({ text: ch, kind: "sym" });
    i += 1;
  }
  return { tokens, partial: "", comment: false };
}

/** A token's comparable form: a word lower-cased, any other kind as written. */
function norm(token: Tok | undefined): string {
  return token === undefined ? "" : token.kind === "word" ? lower(token.text) : token.text;
}

const STATEMENTS: readonly TestsSlotWord[] = [
  { text: "test", id: "stmt.test" },
  { text: "skip", id: "stmt.skip" },
  { text: "given", id: "stmt.given" },
  { text: "set", id: "stmt.set" },
  { text: "clear", id: "stmt.clear" },
  { text: "add row to", id: "stmt.addRow" },
  { text: "remove row", id: "stmt.removeRow" },
  { text: "continue", id: "stmt.continue", final: true },
  { text: "back", id: "stmt.back", final: true },
  { text: "go to", id: "stmt.goTo" },
  { text: "change", id: "stmt.change" },
  { text: "check", id: "stmt.check", final: true },
  { text: "submit", id: "stmt.submit", final: true },
  { text: "expect", id: "stmt.expect" }
];

const EXPECT_LEADS: readonly TestsSlotWord[] = [
  { text: "error on", id: "expect.errorOn" },
  { text: "no error on", id: "expect.noErrorOn" },
  { text: "no errors", id: "expect.noErrors", final: true },
  { text: "message on", id: "expect.messageOn" },
  { text: "accepted", id: "expect.accepted", final: true },
  { text: "refused", id: "expect.refused", final: true },
  { text: "page =", id: "expect.page" },
  { text: "path", id: "expect.path" },
  { text: "submitted", id: "expect.submitted" },
  { text: "rows of", id: "expect.rowsOf" },
  { text: "layout =", id: "expect.layout" }
];

const GIVENS: readonly TestsSlotWord[] = [
  { text: "today", id: "given.today" },
  { text: "locale", id: "given.locale" },
  { text: "journey", id: "given.journey" },
  { text: "host.", id: "given.host" },
  { text: "options for", id: "given.options" }
];

function word(text: string, id: string, extra: Partial<TestsSlotWord> = {}): TestsSlotWord {
  return { text, id, ...extra };
}

const EQUALS: TestsSlotWord = word("=", "expect.equals");

/** The value that follows an `=`: `rest` is what came after it. A value that is complete takes no more. */
function valueSlot(rest: readonly Tok[], base: TestsSlot, extra: Partial<TestsSlot>): TestsSlot {
  let depth = 0;
  for (const token of rest) {
    if (token.text === "(") {
      depth += 1;
    } else if (token.text === ")") {
      depth -= 1;
    }
  }
  const last = rest[rest.length - 1];
  if (rest.length === 0) {
    return { ...base, wants: ["value"], ...extra };
  }
  if (depth > 0 && (last?.text === "(" || last?.text === ",")) {
    return { ...base, wants: ["value"], list: true, ...extra };
  }
  return base;
}

/**
 * The slot at the end of `before`, the line's text up to the caret. Total: any line yields a
 * slot, and a line the grammar does not reach yields one that wants nothing.
 */
export function testsSlotAt(before: string): TestsSlot {
  const lexed = lexBefore(before);
  const none: TestsSlot = { partial: lexed.partial, wants: [], words: [] };
  if (lexed.comment) {
    return none;
  }
  const slot = lexed.quote === undefined ? none : { ...none, quote: lexed.quote };
  const found = statementSlot(lexed.tokens, slot);
  // Inside a string only a value can be completed (an option of a choice, say); a name, a
  // reason or a message in quotes is the author's own text.
  if (lexed.quote !== undefined && !found.wants.includes("value")) {
    return slot;
  }
  return found;
}

function statementSlot(tokens: readonly Tok[], none: TestsSlot): TestsSlot {
  const n = tokens.length;
  if (n === 0) {
    return { ...none, wants: ["statement"], words: STATEMENTS.slice() };
  }
  const w = tokens.map(norm);
  const at = (index: number): string => w[index] ?? "";
  const ask = (wants: TestsSlotWants[], words: TestsSlotWord[] = [], extra: Partial<TestsSlot> = {}): TestsSlot => ({ ...none, wants, words, ...extra });
  switch (at(0)) {
    case "set": {
      if (n === 1) {
        return ask(["field"]);
      }
      if (n === 2) {
        return ask([], [EQUALS]);
      }
      if (at(2) === "=") {
        return valueSlot(tokens.slice(3), none, { field: tokens[1]?.text });
      }
      return none;
    }
    case "clear":
      return n === 1 ? ask(["field"]) : none;
    case "add": {
      if (n === 1) {
        return ask([], [word("row", "stmt.addRow")]);
      }
      if (at(1) !== "row") {
        return none;
      }
      if (n === 2) {
        return ask([], [word("to", "stmt.addRow")]);
      }
      if (at(2) !== "to") {
        return none;
      }
      if (n === 3) {
        return ask(["collection"]);
      }
      const collection = tokens[3]?.text ?? "";
      if (n === 4) {
        return ask([], [word("with", "stmt.addRow")]);
      }
      if (at(4) !== "with") {
        return none;
      }
      return rowWithSlot(tokens.slice(5), collection, none);
    }
    case "remove": {
      if (n === 1) {
        return ask([], [word("row", "stmt.removeRow")]);
      }
      if (at(1) !== "row") {
        return none;
      }
      if (n === 3) {
        return ask([], [word("of", "stmt.removeRow")]);
      }
      return n === 4 && at(3) === "of" ? ask(["collection"]) : none;
    }
    case "go": {
      if (n === 1) {
        return ask([], [word("to", "stmt.goTo")]);
      }
      return n === 2 && at(1) === "to" ? ask(["page"]) : none;
    }
    case "change":
      return n === 1 ? ask(["field"]) : none;
    case "given":
      return givenSlot(tokens, none);
    case "expect":
      return expectSlot(tokens.slice(1), none);
    default:
      return none;
  }
}

/** `add row to c with key = value, key = value`: the part after `with`. */
function rowWithSlot(rest: readonly Tok[], collection: string, none: TestsSlot): TestsSlot {
  let i = 0;
  while (true) {
    if (i >= rest.length) {
      return { ...none, wants: ["rowKey"], collection };
    }
    const key = rest[i];
    i += 1;
    if (i >= rest.length) {
      return { ...none, words: [EQUALS] };
    }
    if (norm(rest[i]) !== "=") {
      return none;
    }
    i += 1;
    const start = i;
    let depth = 0;
    while (i < rest.length) {
      const text = rest[i]?.text;
      if (text === "(") {
        depth += 1;
      } else if (text === ")") {
        depth -= 1;
      } else if (text === "," && depth === 0) {
        break;
      }
      i += 1;
    }
    if (i >= rest.length) {
      return valueSlot(rest.slice(start), none, { field: `${collection}[0].${key?.text ?? ""}` });
    }
    i += 1;
  }
}

function givenSlot(tokens: readonly Tok[], none: TestsSlot): TestsSlot {
  const n = tokens.length;
  const w = tokens.map(norm);
  const at = (index: number): string => w[index] ?? "";
  if (n === 1) {
    return { ...none, wants: ["given"], words: GIVENS.slice() };
  }
  const kind = at(1);
  if (kind === "today" || kind === "locale") {
    if (n === 2) {
      return { ...none, words: [EQUALS] };
    }
    return at(2) === "=" ? valueSlot(tokens.slice(3), none, { given: kind }) : none;
  }
  if (kind === "journey") {
    if (n === 2) {
      return { ...none, words: [EQUALS] };
    }
    return n === 3 && at(2) === "=" ? { ...none, wants: ["journey"], words: [word("none", "given.none", { final: true })] } : none;
  }
  if (kind.startsWith("host.")) {
    if (n === 2) {
      return { ...none, words: [EQUALS] };
    }
    return at(2) === "=" ? valueSlot(tokens.slice(3), none, {}) : none;
  }
  if (kind === "options") {
    if (n === 2) {
      return { ...none, words: [word("for", "given.options")] };
    }
    if (at(2) !== "for") {
      return none;
    }
    if (n === 3) {
      return { ...none, wants: ["field"] };
    }
    if (n === 4) {
      return { ...none, words: [EQUALS] };
    }
    return at(4) === "=" ? valueSlot(tokens.slice(5), { ...none }, { field: tokens[3]?.text, given: "options", list: false }) : none;
  }
  return none;
}

/** The `expect` forms; `e` is the line after the word `expect`. */
function expectSlot(e: readonly Tok[], none: TestsSlot): TestsSlot {
  const m = e.length;
  const w = e.map(norm);
  const at = (index: number): string => w[index] ?? "";
  const ask = (wants: TestsSlotWants[], words: TestsSlotWord[] = [], extra: Partial<TestsSlot> = {}): TestsSlot => ({ ...none, wants, words, ...extra });
  if (m === 0) {
    return ask(["field", "page"], EXPECT_LEADS.slice(), { subject: "" });
  }
  switch (at(0)) {
    case "accepted":
    case "refused":
      return none;
    case "no": {
      if (m === 1) {
        return ask([], [word("error", "expect.noErrorOn"), word("errors", "expect.noErrors", { final: true })]);
      }
      if (at(1) === "error") {
        if (m === 2) {
          return ask([], [word("on", "expect.noErrorOn")]);
        }
        return m === 3 && at(2) === "on" ? ask(["field"]) : none;
      }
      return none;
    }
    case "error": {
      if (m === 1) {
        return ask([], [word("on", "expect.errorOn")]);
      }
      if (at(1) !== "on") {
        return none;
      }
      if (m === 2) {
        return ask(["field"]);
      }
      if (m === 3) {
        return ask([], [word(":", "expect.errorOn")]);
      }
      return m === 4 && at(3) === ":" ? ask(["code"]) : none;
    }
    case "message": {
      if (m === 1) {
        return ask([], [word("on", "expect.messageOn")]);
      }
      if (at(1) !== "on") {
        return none;
      }
      if (m === 2) {
        return ask(["field"]);
      }
      return m === 3 ? ask([], [word("=", "expect.messageOn")]) : none;
    }
    case "page": {
      if (m === 1) {
        return ask([], [word("=", "expect.page")]);
      }
      return m === 2 && at(1) === "=" ? ask(["page"]) : none;
    }
    case "path": {
      if (m === 1) {
        return ask([], [word("=", "expect.path"), word("ends", "expect.pathEnds", { final: true })]);
      }
      if (at(1) === "ends") {
        if (m === 2) {
          return ask([], [word("at", "expect.pathEndsAt")]);
        }
        return m === 3 && at(2) === "at" ? ask(["page"]) : none;
      }
      if (at(1) !== "=") {
        return none;
      }
      if (m === 2) {
        return ask([], [word("(", "expect.path")]);
      }
      if (at(2) !== "(") {
        return none;
      }
      const last = at(m - 1);
      if (last === ")") {
        return none;
      }
      if (last === "(" || last === ",") {
        return ask(["page"]);
      }
      return ask([], [word(",", "expect.path"), word(")", "expect.path", { final: true })]);
    }
    case "submitted": {
      if (m === 1) {
        return ask(["field"]);
      }
      if (m === 2) {
        return ask([], [EQUALS]);
      }
      return at(2) === "=" ? valueSlot(e.slice(3), none, { field: e[1]?.text }) : none;
    }
    case "rows": {
      if (m === 1) {
        return ask([], [word("of", "expect.rowsOf")]);
      }
      if (at(1) !== "of") {
        return none;
      }
      if (m === 2) {
        return ask(["collection"]);
      }
      return m === 3 ? ask([], [word("=", "expect.rowsOf")]) : none;
    }
    case "layout": {
      if (m === 1) {
        return ask([], [word("=", "expect.layout")]);
      }
      return m === 2 && at(1) === "=" ? ask(["layout"]) : none;
    }
    default:
      break;
  }
  // A path (or a page) first: its state, its value, or the page on/off the path.
  const subject = e[0];
  if (subject === undefined || subject.kind !== "word") {
    return none;
  }
  if (m === 1) {
    return ask(["state"], [EQUALS, word("!=", "expect.differs"), word("withheld", "expect.withheld", { final: true, after: "field" }), word("on path", "expect.onPath", { final: true, after: "page" }), word("off path", "expect.offPath", { final: true, after: "page" })], {
      subject: subject.text
    });
  }
  if (at(1) === "=" || at(1) === "!=") {
    return valueSlot(e.slice(2), none, { field: subject.text });
  }
  if (at(1) === "not" && m === 2) {
    return ask([], [word("empty", "expect.equals", { final: true })]);
  }
  if ((at(1) === "on" || at(1) === "off") && m === 2) {
    return ask([], [word("path", "expect.onPath", { final: true })]);
  }
  return none;
}

/** The state words an `expect <path>` takes (`not empty` is two words, typed as one phrase). */
export const TESTS_STATE_WORDS: readonly string[] = ["visible", "hidden", "required", "optional", "enabled", "disabled", "readonly", "editable", "empty", "not empty"];
