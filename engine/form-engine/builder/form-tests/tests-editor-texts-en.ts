/**
 * English for the test editor and its completions (tests-textarea.ts, tests-editor.ts): a lazy chunk the builder loads
 * on first opening Tests, kept out of the eager table in
 * `logic/builder-texts.ts` so the builder entry carries none of it (to keep the eager bundle small). Every key here is read only by code in that chunk, through this module's
 * `builderText` and its kin (or `areaWords`): the lookup is the builder's one, this table only
 * supplies the English. `engine/tests/builder-texts.test.ts` holds each key to exactly one table
 * and each table to its own readers.
 *
 * Two prefixes, so the panel's and the result words' keys (`tests.panel.*`, `tests.result.*`)
 * never meet these: `tests.box.*` for the box itself (marks, problems), `tests.complete.*` for
 * the suggestions (section names, what each statement does). The statement and keyword words of
 * the language itself (`set`, `expect`, `visible`) are English in every locale, so they are not here: only the sentences that explain them are.
 */
import { areaText } from "../logic/builder-texts.js";

export const TESTS_EDITOR_EN = {
  // The gutter's marks: what a line came to in the last run, said in words for the mark's title.
  "tests.box.mark.passed": "Passed",
  "tests.box.mark.failed": "Failed",
  "tests.box.mark.skipped": "Skipped",
  "tests.box.mark.error": "Could not run",
  "tests.box.mark.ran": "Done",
  "tests.box.mark.pending": "Not reached",
  // The problems, read out by assistive technology when the box has the focus (the panel draws the list).
  "tests.box.problem": "Line {line}: {message}",

  // Section names of the suggestion list.
  "tests.complete.section.statements": "Statements",
  "tests.complete.section.fields": "Fields",
  "tests.complete.section.collections": "Repeating sections",
  "tests.complete.section.rowKeys": "Fields of a row",
  "tests.complete.section.values": "Values",
  "tests.complete.section.states": "States",
  "tests.complete.section.codes": "Error codes",
  "tests.complete.section.pages": "Pages",
  "tests.complete.section.journeys": "Journeys",
  "tests.complete.section.layouts": "PDF layouts",
  "tests.complete.section.words": "Next",
  "tests.complete.section.givens": "Givens",
  "tests.complete.footer": "↑↓ to move · Tab to insert · Esc to close",

  // What each statement does, beside it in the list.
  "tests.complete.stmt.test": "Start a test",
  "tests.complete.stmt.skip": "Keep the test but do not run it",
  "tests.complete.stmt.given": "Fix the day, language, journey or a host value",
  "tests.complete.stmt.set": "Answer a field",
  "tests.complete.stmt.clear": "Empty a field",
  "tests.complete.stmt.addRow": "Add a row to a repeating section",
  "tests.complete.stmt.removeRow": "Remove a row",
  "tests.complete.stmt.continue": "Go to the next page",
  "tests.complete.stmt.back": "Go to the previous page",
  "tests.complete.stmt.goTo": "Jump to a page",
  "tests.complete.stmt.change": "Press a Change link on Check answers",
  "tests.complete.stmt.check": "Check the answers without submitting",
  "tests.complete.stmt.submit": "Submit the form",
  "tests.complete.stmt.expect": "State what must be true",

  // What each way of starting an expectation says.
  "tests.complete.expect.errorOn": "A field has an error",
  "tests.complete.expect.noErrorOn": "A field has no error",
  "tests.complete.expect.noErrors": "Nothing is wrong anywhere",
  "tests.complete.expect.messageOn": "A field's error reads",
  "tests.complete.expect.accepted": "The form is accepted",
  "tests.complete.expect.refused": "The form is refused",
  "tests.complete.expect.page": "The page the person is on",
  "tests.complete.expect.path": "The pages on the path",
  "tests.complete.expect.submitted": "A value in the submission",
  "tests.complete.expect.rowsOf": "How many rows a section has",
  "tests.complete.expect.layout": "Which PDF layout is chosen",
  "tests.complete.expect.onPath": "The page is on the path",
  "tests.complete.expect.offPath": "The page is off the path",
  "tests.complete.expect.withheld": "Left out of the submission",
  "tests.complete.expect.equals": "Has this value",
  "tests.complete.expect.differs": "Has any other value",
  "tests.complete.expect.pathEnds": "The journey ends here",
  "tests.complete.expect.pathEndsAt": "The journey ends at an exit page",

  // The givens.
  "tests.complete.given.today": "The day the form runs on",
  "tests.complete.given.locale": "The language the form runs in",
  "tests.complete.given.journey": "The journey to follow",
  "tests.complete.given.host": "A value the host supplies",
  "tests.complete.given.options": "The options of a list that comes from a data source",
  "tests.complete.given.none": "The whole form on one page",

  // Values, by what the field takes.
  "tests.complete.value.text": "Text in quotes",
  "tests.complete.value.number": "A number",
  "tests.complete.value.date": "A date, like @\"2026-01-31\"",
  "tests.complete.value.list": "A list in brackets",
  "tests.complete.value.true": "Ticked",
  "tests.complete.value.false": "Not ticked",
  "tests.complete.value.null": "No value",
  "tests.complete.value.option": "An option of the field",
  "tests.complete.value.options": "All the options",

  // On a field or page that needs saying where it sits.
  "tests.complete.rowField": "A field of each row of {collection}. Rows count from 0, so this is the first row; change the number for another.",
  "tests.complete.pageOf": "A page of the journey {journey}"
} as const satisfies Record<string, string>;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(TESTS_EDITOR_EN);
