/**
 * The Tests editor's "Add step" menu: every statement the language has,
 * written out for a field the author picks, so a test can be built without remembering the
 * syntax while the text stays the only storage. The model is pure (the panel draws the menu from
 * it and a test reads it without a DOM): {@link addStepFields} lists what may be picked and
 * {@link addStepChoices} the groups of statements, each a label in the builder's words and the
 * line it inserts.
 *
 * Fields, pages, layouts and codes are read through the editor's completion lists
 * (`tests-completions.ts`), so the menu and the completions never disagree about what a test may
 * name. A value is a placeholder the author edits: a string field `""`, a number `0`, a date
 * `@"2026-01-01"`, a checkbox `true`, a choice its first option's value, a checkbox group or a
 * multiple choice a list of its first option.
 */
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { BuilderTextOptions } from "../logic/builder-texts.js";
import { createTestsCompletions, type TestsCompletionLists } from "./tests-completions.js";
import { testsStringLiteral } from "./tests-accept.js";
import { builderText } from "./tests-panel-texts-en.js";

export type AddStepGroupId = "set" | "state" | "value" | "error" | "journey" | "rows" | "output";

/** A field the menu's picker offers: its path as the language reads it, its label, and the value a statement starts from. */
export interface AddStepField {
  path: string;
  label: string;
  type: string;
  /** A repeating section or a data grid: rows are added to it and counted, it holds no single value. */
  collection: boolean;
  /** A literal of the field's kind for a `set` or a value expectation to start from. */
  placeholder: string;
}

export interface AddStepStatement {
  /** What the menu item says, in the builder's words. */
  label: string;
  /** The line inserted, without indentation (the editor indents it like its neighbours). */
  text: string;
}

export interface AddStepGroup {
  id: AddStepGroupId;
  title: string;
  statements: AddStepStatement[];
}

export interface AddStepOptions {
  /** The picked field's path; absent, the first field that is not a collection. */
  field?: string | undefined;
  text?: BuilderTextOptions | undefined;
}

const STATES: ReadonlyArray<{ word: string; key: Parameters<typeof builderText>[0] }> = [
  { word: "visible", key: "tests.addStep.state.visible" },
  { word: "hidden", key: "tests.addStep.state.hidden" },
  { word: "required", key: "tests.addStep.state.required" },
  { word: "optional", key: "tests.addStep.state.optional" },
  { word: "enabled", key: "tests.addStep.state.enabled" },
  { word: "disabled", key: "tests.addStep.state.disabled" },
  { word: "readonly", key: "tests.addStep.state.readonly" },
  { word: "editable", key: "tests.addStep.state.editable" },
  { word: "empty", key: "tests.addStep.state.empty" },
  { word: "not empty", key: "tests.addStep.state.notEmpty" }
];

/** The day a date placeholder names: any day does, this one is easy to spot and edit. */
const PLACEHOLDER_DAY = '@"2026-01-01"';

/** The literal a field's statements start from, by what the field stores. */
function placeholderOf(lists: TestsCompletionLists, path: string): string {
  const kind = lists.kindOf(path);
  const first = lists.optionsOf(path)[0]?.value;
  switch (kind) {
    case "number":
      return "0";
    case "date":
      return PLACEHOLDER_DAY;
    case "boolean":
      return "true";
    case "choice":
      return first !== undefined ? testsStringLiteral(first) : '""';
    case "flags":
    case "list":
      return first !== undefined ? `(${testsStringLiteral(first)})` : "()";
    default:
      return '""';
  }
}

function listsOf(root: ComponentNode, definition: FormDefinition | undefined, codes: readonly string[]): TestsCompletionLists {
  return createTestsCompletions(
    () => root,
    () => definition,
    () => codes
  );
}

function fieldsOf(lists: TestsCompletionLists): AddStepField[] {
  return lists.fields().map((field) => {
    const collection = lists.isCollection(field.path);
    return { path: field.path, label: field.label, type: field.type, collection, placeholder: collection ? "" : placeholderOf(lists, field.path) };
  });
}

/** What the picker offers, in document order: every field a test may name, row fields as `items[0].qty`. */
export function addStepFields(root: ComponentNode, definition?: FormDefinition, codes: readonly string[] = []): AddStepField[] {
  return fieldsOf(listsOf(root, definition, codes));
}

/**
 * The menu's groups for the picked field (or the first field that holds a value). A group with
 * nothing to offer (no field, no journey, no repeating section, no PDF layout) is left out, so
 * the menu never lists a statement the form could not answer.
 */
export function addStepChoices(root: ComponentNode, definition: FormDefinition | undefined, codes: readonly string[], options: AddStepOptions = {}): AddStepGroup[] {
  const lists = listsOf(root, definition, codes);
  const fields = fieldsOf(lists);
  const text = options.text;
  const word = (key: Parameters<typeof builderText>[0], params?: Record<string, string | number>): string => builderText(key, params, text);
  const picked = fields.find((field) => field.path === options.field) ?? fields.find((field) => !field.collection);
  const groups: AddStepGroup[] = [];
  const push = (id: AddStepGroupId, title: string, statements: AddStepStatement[]): void => {
    if (statements.length > 0) {
      groups.push({ id, title, statements });
    }
  };

  if (picked !== undefined && !picked.collection) {
    const field = picked.label;
    const path = picked.path;
    push("set", word("tests.addStep.group.set"), [
      { label: word("tests.addStep.set", { field }), text: `set ${path} = ${picked.placeholder}` },
      { label: word("tests.addStep.clear", { field }), text: `clear ${path}` }
    ]);
    push(
      "state",
      word("tests.addStep.group.state"),
      STATES.map((state) => ({ label: word(state.key, { field }), text: `expect ${path} ${state.word}` }))
    );
    push("value", word("tests.addStep.group.value"), [{ label: word("tests.addStep.value", { field }), text: `expect ${path} = ${picked.placeholder}` }]);
    const errors: AddStepStatement[] = [
      { label: word("tests.addStep.error.required", { field }), text: `expect error on ${path}: required` },
      { label: word("tests.addStep.error.rule", { field }), text: `expect error on ${path}: rule` },
      { label: word("tests.addStep.error.any", { field }), text: `expect error on ${path}` }
    ];
    // The host's own codes (a server's `taxId.unknown`): the engine's are many and the two above are the ones a rule raises.
    for (const code of codes) {
      // Only a code the language can spell after the colon (Accept's own guard): any other would insert a line that does not parse.
      if (code !== "required" && code !== "rule" && /^[A-Za-z0-9._-]+$/.test(code)) {
        errors.push({ label: word("tests.addStep.error.code", { field, code }), text: `expect error on ${path}: ${code}` });
      }
    }
    errors.push(
      { label: word("tests.addStep.error.none", { field }), text: `expect no error on ${path}` },
      { label: word("tests.addStep.error.noErrors"), text: "expect no errors" }
    );
    push("error", word("tests.addStep.group.error"), errors);
  } else {
    push("error", word("tests.addStep.group.error"), [{ label: word("tests.addStep.error.noErrors"), text: "expect no errors" }]);
  }

  const journey: AddStepStatement[] = [];
  const pages = lists.pages();
  if (pages.length > 0) {
    journey.push({ label: word("tests.addStep.journey.continue"), text: "continue" }, { label: word("tests.addStep.journey.back"), text: "back" });
    for (const page of pages) {
      journey.push({ label: word("tests.addStep.journey.goTo", { page: page.label }), text: `go to ${page.id}` });
    }
    for (const page of pages) {
      journey.push({ label: word("tests.addStep.journey.page", { page: page.label }), text: `expect page = ${page.id}` });
    }
  }
  // A Check answers step's Change link for the picked field, while some journey has such a step.
  const reviews = (definition?.journey?.journeys ?? []).some((entry) => (entry.pages ?? []).some((page) => page.kind === "review"));
  if (reviews && picked !== undefined && !picked.collection) {
    journey.push({ label: word("tests.addStep.journey.change", { field: picked.label }), text: `change ${picked.path}` });
  }
  journey.push(
    { label: word("tests.addStep.journey.check"), text: "check" },
    { label: word("tests.addStep.journey.submit"), text: "submit" },
    { label: word("tests.addStep.journey.accepted"), text: "expect accepted" },
    { label: word("tests.addStep.journey.refused"), text: "expect refused" }
  );
  push("journey", word("tests.addStep.group.journey"), journey);

  const rows: AddStepStatement[] = [];
  for (const collection of fields.filter((field) => field.collection)) {
    const field = collection.label;
    rows.push(
      { label: word("tests.addStep.rows.add", { field }), text: `add row to ${collection.path}` },
      { label: word("tests.addStep.rows.remove", { field }), text: `remove row 0 of ${collection.path}` },
      { label: word("tests.addStep.rows.count", { field }), text: `expect rows of ${collection.path} = 1` }
    );
  }
  push("rows", word("tests.addStep.group.rows"), rows);

  const output: AddStepStatement[] = [];
  if (picked !== undefined && !picked.collection) {
    output.push(
      { label: word("tests.addStep.output.submitted", { field: picked.label }), text: `expect submitted ${picked.path} = ${picked.placeholder}` },
      { label: word("tests.addStep.output.withheld", { field: picked.label }), text: `expect ${picked.path} withheld` }
    );
  }
  for (const layout of lists.layouts()) {
    output.push({ label: word("tests.addStep.output.layout", { layout: layout.label }), text: `expect layout = ${layout.id}` });
  }
  push("output", word("tests.addStep.group.output"), output);
  return groups;
}
