/**
 * The page-only fields' English (their lazy chunk, which may not import the designer's), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it (to keep the eager bundle small). Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const JOURNEY_AUTHORING_EN = {
  "journey.designer.own.keptNote": "Kept in the browser: checked here and kept in drafts; never sent, printed or exported.",
  "journey.designer.own.notSent": "Not sent",
  "journey.designer.own.workedOutValue": "Worked-out value",
  "journey.designer.own.allPlaced": "Every form field of this kind is already on a step or worked out here.",
  "journey.designer.own.noneToFill": "No form field of this kind to fill.",
  "journey.designer.own.workedOutLabel": "Worked out: {field}",
  "journey.designer.own.noField": "no field yet",
  "journey.designer.own.noneKept": "None: kept in the browser",
  "journey.designer.own.reservedId": "Ids starting with “journey” are the designer's own; give the field another.",
  "journey.designer.ui.form-field": "Form field",
  "journey.designer.ui.the-form-field-this-value-is-worked-out-into-on-th": "The form field this value is worked out into, on this step; how, on the Rules tab (Worked out as). The server checks it with the field's own rules.",
  "journey.designer.ui.label": "Label",
  "journey.designer.ui.blank-the-form-field-s-own-label": "Blank: the form field's own label.",
  "journey.designer.ui.the-page-only-field-s-id-what-this-journey-s-own-r": "The page-only field's id: what this journey's own rules and worked-out values read it by, and where drafts keep its answer. Never a form component's or a step's id; a rename follows into what reads it.",
  "journey.designer.ui.choose": "— choose —",
  "journey.designer.own.fillsField": "Fills form field",
  "journey.designer.own.fillsField.description": "The form field this answer is: stored there, sent, printed and checked with the form's rules. None: kept in the browser."
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(JOURNEY_AUTHORING_EN);
