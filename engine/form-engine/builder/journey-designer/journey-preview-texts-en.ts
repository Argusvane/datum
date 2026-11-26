/**
 * The journey try session's English (its lazy chunk, which may not import the designer's), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it (to keep the eager bundle small). Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const JOURNEY_PREVIEW_EN = {
  "journey.preview.note.server": "No step checks with the server in Try it: the server knows the saved journey, not this one.",
  "journey.preview.note.engine": "Host validators are off: only the form's own constraints are checked.",
  "journey.preview.submit": "The journey would submit here.",
  "journey.preview.link": "Links do not open in Try it.",
  "journey.preview.couldNotStart": "The journey could not start.",
  "journey.preview.cannotRun": "This journey cannot run as it stands.",
  "journey.preview.noPages": "This journey has no steps yet.",
  "journey.preview.noPageApplies": "No step of this journey applies to the answers so far.",
  "journey.preview.problem.cannotRun": "This journey cannot run as it stands ({problem}); Try it runs the last version that could.",
  "journey.preview.problem.couldNotStart": "The journey could not start: {problem}",
  "journey.preview.path.gone": "a step no longer in the journey",
  "journey.preview.path.exit": "an exit step",
  "journey.preview.path.page": "step {number} of {total}",
  "journey.preview.returning": "{step} · changing an answer. Continue returns to {review}.",
  "journey.preview.title": "Journey",
  "journey.preview.restart": "Restart",
  "journey.preview.restart.title": "Start the journey again from its first step, with no answers",
  "journey.preview.show": "Open this step",
  "journey.preview.show.title": "Back to editing, this step open",
  "journey.preview.notSubmitted.one": "Not submitted: an answer needs attention.",
  "journey.preview.notSubmitted.other": "Not submitted: {count} answers need attention.",
  "journey.preview.error.answers": "The journey's answers could not be checked",
  "journey.preview.error.start": "The journey's preview could not start",
  "journey.preview.ownField": "A field of this journey",
  "journey.preview.theForm": "The form"
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(JOURNEY_PREVIEW_EN);
