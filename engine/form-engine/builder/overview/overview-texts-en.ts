/**
 * The Journeys and PDF overviews' English (a lazy chunk), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it. Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const OVERVIEW_EN = {
  // The workspace surfaces
  "overview.empty": "Nothing to show yet.",
  "overview.noProblems": "No problems",
  "overview.pending": "Not checked yet",
  "overview.checkFailed": "Couldn't check",
  "overview.checkFailedEvent": "The journeys could not be checked because their diagnostics did not load. Check the connection and edit a journey to try again.",
  "overview.journey.detail": "{pages} · asks {asked} of {answers} fields{first}",
  "overview.journey.first": " · the form opens as this",
  "overview.pages.one": "{count} page",
  "overview.pages.other": "{count} pages",
  "overview.open": "Open",
  "overview.open.label": "Open {name}",
  "overview.new.journey": "+ New journey",
  "overview.new.layout": "+ New layout",
  "overview.journeys": "Journeys",
  "overview.journeys.none": "No journeys yet: the form is filled in as one flow. A journey asks some of its fields, page by page.",
  "overview.pdf.title": "PDF layouts",
  "overview.pdf.order": "Tried in order; the first whose rule matches prints.",
  "overview.pdf.none": "No layouts: a PDF of this form prints from the form as it stands.",
  "overview.kind.template": "Fills a PDF",
  "overview.kind.generated": "Generated",
  "overview.pdf.missingField": "Field \"{name}\" is not in the form",
  "overview.default": "default",
  "overview.when": "when {condition}",
  "overview.sep": " · "
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(OVERVIEW_EN);
