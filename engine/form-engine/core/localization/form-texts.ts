import type { LocalizedText, TranslationCatalog } from "../schema/contracts.js";
import { resolveLocalizedText } from "./localized-text.js";
import { addressOf, engineWord, lookupText, packText, type EngineWordSources } from "./translations.js";

export type { EngineWordSources, LanguagePack, LanguagePackTable } from "./translations.js";

/**
 * The form's own wording: what the renderer says in its own voice, apart from anything the
 * form authors (labels, descriptions, the button captions) and apart from validation text
 * (`ValidationMessageCatalog`, keyed by error code). Each entry is a `LocalizedText` (host data),
 * so a page words it per locale inline.
 *
 * Five layers word a text, the first that has it winning: the page's own catalog
 * (`<datum-form texts>`), then the form's `texts` translations for the locale (the host
 * catalog's over the definition's map, at `texts › form › <key>`), then a layer of the
 * drawing's own (a print theme's `texts`: its design system's conventions), then a binding's
 * language pack (`LanguagePack.texts`), then the engine's English, the only language it words
 * itself. A binding's adapters may read keys of their own through the same catalog (a date
 * group's part labels, a file uploader's "Choose file"), which is what the index signature
 * admits; an unknown key with no wording anywhere resolves to the key itself, so a typo
 * shows on the page rather than vanishing.
 *
 * `{{name}}` placeholders are filled from the params a caller passes: the summary's
 * `{{count}}`, an entry's `{{label}}` and `{{message}}`, a file row's `{{name}}`.
 */
export interface FormTextCatalog {
  /** The line shown while a submission and its delivery are in flight. */
  submitting?: LocalizedText | undefined;
  /**
   * The marker after a required field's label — `*` unless worded otherwise ("(required)").
   * Empty for a design system that marks the optional fields instead, as GOV.UK does.
   */
  required?: LocalizedText | undefined;
  /** The marker after an optional field's label ("(optional)"); none unless worded. */
  optional?: LocalizedText | undefined;
  /**
   * The sentence above the fields that explains the required marker ("Fields marked with *
   * are required"), drawn only when the form has a required field; none unless worded.
   */
  requiredNote?: LocalizedText | undefined;
  /** A select's empty option, unless the component has a placeholder of its own. */
  selectEmpty?: LocalizedText | undefined;
  /** A visually-hidden prefix read before an inline error ("Error:"); none unless worded. */
  errorPrefix?: LocalizedText | undefined;
  /** The error summary's heading; `{{count}}` is the number of errors. */
  summaryHeading?: LocalizedText | undefined;
  summaryHeadingOne?: LocalizedText | undefined;
  loading?: LocalizedText | undefined;
  validateLabel?: LocalizedText | undefined;
  printLabel?: LocalizedText | undefined;
  /**
   * The host toolbar's Print menu, when the form offers more than one rendition: what prints the
   * person's answers, a blank paper form to fill in by hand, and the paper form with the answers
   * written in.
   */
  printAnswers?: LocalizedText | undefined;
  printBlank?: LocalizedText | undefined;
  printFilled?: LocalizedText | undefined;
  pdfLabel?: LocalizedText | undefined;
  downloadPdfLabel?: LocalizedText | undefined;
  /** The alert a form's own PDF button shows when the PDF module could not be loaded (the form still works when the PDF code is absent). */
  pdfUnavailable?: LocalizedText | undefined;
  /** The alert a form shows in place of the form when its definition could not be loaded from `src` (or the one the page gave was refused). */
  definitionUnavailable?: LocalizedText | undefined;
  /** The alert a journey form shows when its journeys runtime could not be loaded, above a Retry button. */
  journeysUnavailable?: LocalizedText | undefined;
  /** The Retry button on that alert. */
  retry?: LocalizedText | undefined;
  pdfLayoutLabel?: LocalizedText | undefined;
  localeLabel?: LocalizedText | undefined;
  /** One entry of the error summary; `{{label}}` the field's, `{{message}}` the error's. */
  summaryEntry?: LocalizedText | undefined;
  /** A file row's Remove control, and its accessible name with the file's `{{name}}`. */
  fileRemove?: LocalizedText | undefined;
  fileRemoveFile?: LocalizedText | undefined;
  /** What the field's status region says once a file is removed, with the file's `{{name}}`. */
  fileRemoved?: LocalizedText | undefined;
  /**
   * What the status region says once a pick lands, where the field's face announces picks
   * (the file adapter's `announceSelection`): one file (`{{names}}`), several
   * (`{{count}}` and `{{names}}`, comma-separated).
   */
  fileAnnounced?: LocalizedText | undefined;
  fileAnnouncedMany?: LocalizedText | undefined;
  /** The title of an embedded attachment's download, with the file's `{{name}}`. */
  fileDownload?: LocalizedText | undefined;
  /** A read-only file field holding nothing. */
  fileNone?: LocalizedText | undefined;
  /** The engine's language switcher's label, when the part names none. */
  languageSwitcher?: LocalizedText | undefined;
  /** A date's part labels and its month select's empty caption. */
  dateDay?: LocalizedText | undefined;
  dateMonth?: LocalizedText | undefined;
  dateYear?: LocalizedText | undefined;
  dateSelectMonth?: LocalizedText | undefined;
  /** The language links' hidden heading. */
  languageSelection?: LocalizedText | undefined;
  /**
   * A field's character count: the limit sentence a screen reader gets with the
   * field's description, the count as a person types (`countLeft` and its singular), the count
   * past the limit (`countOver` and its singular), and what an empty field shows (`countEmpty`;
   * none unless worded, when the count reads as `countLeft` with the whole limit left). Each
   * takes `{{max}}` (the limit), `{{count}}` (characters typed) and `{{n}}` (characters left,
   * or over).
   */
  countUpTo?: LocalizedText | undefined;
  countEmpty?: LocalizedText | undefined;
  countLeft?: LocalizedText | undefined;
  countLeftOne?: LocalizedText | undefined;
  countOver?: LocalizedText | undefined;
  countOverOne?: LocalizedText | undefined;
  /**
   * A multi-step form's wording: the progress line (`{{n}}` of `{{total}}`), the
   * Back and Continue buttons, and what the indicator says of a step beside its name.
   */
  stepOf?: LocalizedText | undefined;
  /** What a step heading reads between its tag and its name, visually hidden (": "). */
  stepTagSeparator?: LocalizedText | undefined;
  back?: LocalizedText | undefined;
  continue?: LocalizedText | undefined;
  stepCompleted?: LocalizedText | undefined;
  stepNotCompleted?: LocalizedText | undefined;
  /**
   * A journey's wording, beside the `back` and `continue` it shares with the steps
   * container: the caption over a page's heading when the journey counts its pages (`{{n}}` of
   * `{{total}}`, questions pages only), the last page's button, the line shown while the
   * host's server checks the answers, and what the form says when that server cannot be
   * reached. A journey and each of its pages may word these too (`Journey.texts`,
   * `JourneyPage.texts`), over everything here.
   */
  pageOf?: LocalizedText | undefined;
  submit?: LocalizedText | undefined;
  checking?: LocalizedText | undefined;
  serverUnavailable?: LocalizedText | undefined;
  /** The line a journey page draws when the page asked for (`page`, a draft's) was not open to the answers and the person was put on the page they can reach. */
  pageRedirected?: LocalizedText | undefined;
  /**
   * A journey's Check answers page (`kind: "review"`): the link beside an answer that opens the
   * step it was given on (`change`), its whole name for assistive technology with the row's
   * wording in `{{label}}` (`changeHidden`: the words after `change` are visually hidden), what an
   * optional question left blank says (`notProvided`), and the link in place of a required answer
   * not given (`enterAnswer`).
   */
  change?: LocalizedText | undefined;
  changeHidden?: LocalizedText | undefined;
  notProvided?: LocalizedText | undefined;
  enterAnswer?: LocalizedText | undefined;
  /**
   * The line under a worked-out value's read-only copy: the form field a
   * presentation computes from the page's own answers, which the person cannot type into.
   */
  workedOut?: LocalizedText | undefined;
  /**
   * The word a notice's kind adds for assistive technology, read before its title or message
   * and never drawn ("Success: ", "Error: "), as gcds-notice's role words are. The default
   * notice carries it; a binding whose notice part draws its own (GC Design System) words it there.
   */
  noticeSuccess?: LocalizedText | undefined;
  noticeInfo?: LocalizedText | undefined;
  noticeWarning?: LocalizedText | undefined;
  noticeError?: LocalizedText | undefined;
  /** The accessible name of the help mark beside a label ("Help"), which a keyboard reaches and shows the help bubble from. */
  tooltipHelp?: LocalizedText | undefined;
  /**
   * The title over a tabs container's list of links where its panels stack
   * (`DatumControls.tabsFrom`), as govuk-tabs__title says it.
   */
  tabsContents?: LocalizedText | undefined;
  /**
   * What a tab says of the blocking errors in its panel (`{{count}}`), for a binding whose tab
   * says it holds errors: `tabHasErrorsOne` for one, `tabHasErrors` otherwise (`plural`).
   */
  tabHasErrors?: LocalizedText | undefined;
  tabHasErrorsOne?: LocalizedText | undefined;
  /** The note beside a field that prints while a rule hides it, when its author wrote none. */
  printOnlyIf?: LocalizedText | undefined;
  /**
   * The printed form's own words: what an answer left empty says, the page number line
   * in the footer (`{{page}}` and `{{pages}}` become the page counters), the word a chosen option
   * carries for a reader of the PDF, and the heading of a printed grid's row number column.
   */
  printEmpty?: LocalizedText | undefined;
  printPageNumber?: LocalizedText | undefined;
  printChosen?: LocalizedText | undefined;
  printRowNumber?: LocalizedText | undefined;
  /**
   * A data grid's captions: its Add button, each row's Remove / Move up / Move down
   * buttons, the line shown in place of the rows when there are none, a row's name (`{{n}}` is
   * its 1-based number: the row header and the error summary's "Row n: Label"), and the header
   * of the column holding the row buttons. A grid's own `addLabel`, `removeLabel`, `rowLabel`
   * and `emptyText` outrank these.
   */
  dataGridAdd?: LocalizedText | undefined;
  dataGridRemove?: LocalizedText | undefined;
  dataGridMoveUp?: LocalizedText | undefined;
  dataGridMoveDown?: LocalizedText | undefined;
  dataGridEmpty?: LocalizedText | undefined;
  dataGridRow?: LocalizedText | undefined;
  dataGridActions?: LocalizedText | undefined;
  /**
   * The agent tools' person-facing wording: the session banner (its region label,
   * its line with `{{purpose}}`, its Stop / Allow again / Undo all / Dismiss buttons) and the
   * live-region announcements of what an assistant did. Every counted one comes in the
   * `{base}One` / `{base}` pair the resolver's `plural(base, count)` reads on its own
   * (`agentFilledOne` / `agentFilled`, `agentRowsAddedOne` / `agentRowsAdded`): no caller
   * needs fallback keys. The rest are what an assistant did with the saved draft and the PDF,
   * and the ended banner's line when a restored draft cut the session's undo short.
   */
  agentBannerLabel?: LocalizedText | undefined;
  agentBanner?: LocalizedText | undefined;
  agentStop?: LocalizedText | undefined;
  agentAllowAgain?: LocalizedText | undefined;
  agentUndoAll?: LocalizedText | undefined;
  agentDismiss?: LocalizedText | undefined;
  agentSessionStarted?: LocalizedText | undefined;
  agentSessionEnded?: LocalizedText | undefined;
  agentStopped?: LocalizedText | undefined;
  agentStoppedOne?: LocalizedText | undefined;
  agentPaused?: LocalizedText | undefined;
  agentFilled?: LocalizedText | undefined;
  agentFilledOne?: LocalizedText | undefined;
  agentRowsAdded?: LocalizedText | undefined;
  agentRowsAddedOne?: LocalizedText | undefined;
  agentRowRemoved?: LocalizedText | undefined;
  agentMoved?: LocalizedText | undefined;
  agentLanguage?: LocalizedText | undefined;
  agentUndone?: LocalizedText | undefined;
  agentUndoneOne?: LocalizedText | undefined;
  agentSubmitted?: LocalizedText | undefined;
  agentDraftSaved?: LocalizedText | undefined;
  agentDraftRestored?: LocalizedText | undefined;
  agentDraftCleared?: LocalizedText | undefined;
  agentPdfDownloaded?: LocalizedText | undefined;
  agentSessionEndedAfterRestore?: LocalizedText | undefined;
  /** A binding's own keys. */
  [key: string]: LocalizedText | undefined;
}

/** The keys the engine itself words. */
export type EngineFormTextKey =
  | "submitting"
  | "required"
  | "optional"
  | "requiredNote"
  | "selectEmpty"
  | "errorPrefix"
  | "summaryHeading"
  | "summaryHeadingOne"
  | "loading"
  | "validateLabel"
  | "printLabel"
  | "printAnswers"
  | "printBlank"
  | "printFilled"
  | "pdfLabel"
  | "downloadPdfLabel"
  | "pdfUnavailable"
  | "definitionUnavailable"
  | "journeysUnavailable"
  | "retry"
  | "pdfLayoutLabel"
  | "localeLabel"
  | "summaryEntry"
  | "fileRemove"
  | "fileRemoveFile"
  | "fileRemoved"
  | "fileAnnounced"
  | "fileAnnouncedMany"
  | "fileDownload"
  | "fileNone"
  | "languageSwitcher"
  | "dateDay"
  | "dateMonth"
  | "dateYear"
  | "dateSelectMonth"
  | "languageSelection"
  | "countUpTo"
  | "countEmpty"
  | "countLeft"
  | "countLeftOne"
  | "countOver"
  | "countOverOne"
  | "stepOf"
  | "stepTagSeparator"
  | "back"
  | "continue"
  | "stepCompleted"
  | "stepNotCompleted"
  | "pageOf"
  | "submit"
  | "checking"
  | "serverUnavailable"
  | "pageRedirected"
  | "change"
  | "changeHidden"
  | "notProvided"
  | "enterAnswer"
  | "workedOut"
  | "confirmationTitle"
  | "confirmationMessage"
  | "confirmationReference"
  | "noticeSuccess"
  | "noticeInfo"
  | "noticeWarning"
  | "noticeError"
  | "tooltipHelp"
  | "tabsContents"
  | "tabHasErrors"
  | "tabHasErrorsOne"
  | "tabFallback"
  | "stepFallback"
  | "printOnlyIf"
  | "printEmpty"
  | "printPageNumber"
  | "printChosen"
  | "printRowNumber"
  | "dataGridAdd"
  | "dataGridRemove"
  | "dataGridMoveUp"
  | "dataGridMoveDown"
  | "dataGridEmpty"
  | "dataGridRow"
  | "dataGridActions"
  | "unknownComponent"
  | "unknownComponentHint"
  | "formNotShown"
  | "formPartlyShown"
  | "fieldPending"
  | "imageEmpty"
  | "optionsLoading"
  | "optionsFailed"
  | "optionsTruncated"
  | "agentBannerLabel"
  | "agentBanner"
  | "agentStop"
  | "agentAllowAgain"
  | "agentUndoAll"
  | "agentDismiss"
  | "agentSessionStarted"
  | "agentSessionEnded"
  | "agentStopped"
  | "agentStoppedOne"
  | "agentPaused"
  | "agentFilled"
  | "agentFilledOne"
  | "agentRowsAdded"
  | "agentRowsAddedOne"
  | "agentRowRemoved"
  | "agentMoved"
  | "agentLanguage"
  | "agentUndone"
  | "agentUndoneOne"
  | "agentSubmitted"
  | "agentDraftSaved"
  | "agentDraftRestored"
  | "agentDraftCleared"
  | "agentPdfDownloaded"
  | "agentSessionEndedAfterRestore";

/** An engine key, or a binding's own. */
export type FormTextKey = EngineFormTextKey | (string & {});

/** What the renderer says when neither the page nor the binding gave it wording. */
export const DEFAULT_FORM_TEXTS: Readonly<Record<EngineFormTextKey, string>> = {
  submitting: "Submitting…",
  required: "*",
  optional: "",
  requiredNote: "",
  selectEmpty: "Select…",
  errorPrefix: "",
  summaryHeading: "{{count}} errors",
  summaryHeadingOne: "{{count}} error",
  // The form host's toolbar (names for the buttons and the layout picker) and the placeholder
  // shown before the first paint; the locale select's title when the host gives no label.
  loading: "Loading form…",
  validateLabel: "Validate",
  printLabel: "Print",
  // The Print menu's choices, when the form offers more than one rendition.
  printAnswers: "Answers",
  printBlank: "Blank form",
  printFilled: "Filled-in form",
  pdfLabel: "PDF",
  downloadPdfLabel: "Download PDF",
  pdfUnavailable: "The PDF could not be created because part of the form did not load. Check the connection and try again.",
  definitionUnavailable: "This form could not be loaded.",
  journeysUnavailable: "This form could not be loaded because part of it did not arrive. Check the connection and try again.",
  retry: "Try again",
  pdfLayoutLabel: "PDF layout",
  localeLabel: "Form locale",
  summaryEntry: "{{label}}: {{message}}",
  fileRemove: "Remove",
  fileRemoveFile: "Remove {{name}}",
  fileDownload: "Download {{name}}",
  fileNone: "No file",
  languageSwitcher: "Language",
  dateDay: "Day",
  dateMonth: "Month",
  dateYear: "Year",
  dateSelectMonth: "Select a month",
  fileRemoved: "File removed: {{name}}",
  fileAnnounced: "You have selected the file: {{names}}",
  fileAnnouncedMany: "You have selected {{count}} files: {{names}}",
  languageSelection: "Language selection",
  countUpTo: "You can enter up to {{max}} characters",
  countEmpty: "",
  countLeft: "{{n}} characters left",
  countLeftOne: "{{n}} character left",
  countOver: "{{n}} characters over limit",
  countOverOne: "{{n}} character over limit",
  stepOf: "Step {{n}} of {{total}}",
  stepTagSeparator: ": ",
  back: "Back",
  continue: "Continue",
  stepCompleted: "completed",
  stepNotCompleted: "not completed",
  // A journey's page caption, last button, server check line and its failure.
  pageOf: "Step {{n}} of {{total}}",
  submit: "Submit",
  checking: "Checking your answers…",
  serverUnavailable: "We could not check your answers. Try again.",
  pageRedirected: "The page you asked for is not available yet. This is the nearest page you can open.",
  // A journey's Check answers page: the Change link, its name with the row's wording, a blank optional answer, a missing required one.
  change: "Change",
  changeHidden: "Change {{label}}",
  notProvided: "Not provided",
  enterAnswer: "Enter {{label}}",
  // A worked-out value's read-only copy.
  workedOut: "Worked out from your answers",
  // The built-in confirmation an accepted submit shows (`<datum-form confirmation>`).
  confirmationTitle: "Your form was submitted",
  confirmationMessage: "Thank you. We have received your answers.",
  confirmationReference: "Reference",
  // The kind word a notice carries for assistive technology.
  noticeSuccess: "Success: ",
  noticeInfo: "Information: ",
  noticeWarning: "Warning: ",
  noticeError: "Error: ",
  tooltipHelp: "Help",
  // A tabs container's title over its links where the panels stack (DatumControls.tabsFrom).
  tabsContents: "Contents",
  // What a tab says of the blocking errors in its panel, where the binding's tab says it.
  tabHasErrors: "{{count}} errors",
  tabHasErrorsOne: "{{count}} error",
  // The name of a tab its author left untitled, by its place among the tabs.
  tabFallback: "Tab {{n}}",
  // The name of a step its author left untitled, by its place among the steps.
  stepFallback: "Step {{n}}",
  // The note beside a field that prints while a rule hides it, when its author wrote none.
  printOnlyIf: "Complete only if it applies to you.",
  // The printed form's own words.
  printEmpty: "Not answered",
  printPageNumber: "Page {{page}} of {{pages}}",
  printChosen: "Chosen",
  printRowNumber: "#",
  // A data grid's captions; `{{n}}` is a row's 1-based number.
  dataGridAdd: "Add row",
  dataGridRemove: "Remove",
  dataGridMoveUp: "Move up",
  dataGridMoveDown: "Move down",
  dataGridEmpty: "No rows yet.",
  dataGridRow: "Row {{n}}",
  dataGridActions: "Actions",
  // A component whose type nothing draws: the note drawn in its place.
  unknownComponent: "Unknown component “{{type}}”",
  unknownComponentHint: "This part of the form cannot be shown: nothing is registered for its component type. Register the plugin that provides it.",
  // The live renderer's alerts: the form could not be drawn at all (its design system's files
  // did not arrive, the first draw failed), or part of it did not finish drawing in time.
  formNotShown: "This form could not be shown. Check the connection and try again.",
  formPartlyShown: "Part of this form did not finish loading, so it may not work as expected.",
  // A field whose answer an async check is looking at, where its design system has no way to show that (capability `pending` degraded): the word folded into its hint.
  fieldPending: "Checking this answer…",
  // An image component with no usable URL: the empty frame's caption, so the builder canvas shows where the picture goes.
  imageEmpty: "No image URL",
  // A field whose choices come from a data source: the line under it
  // while the source has not answered, when it failed, and when its list was cut to the cap.
  optionsLoading: "Loading the choices…",
  optionsFailed: "The choices could not be loaded.",
  optionsTruncated: "Showing the first {{shown}} of {{total}} choices.",
  // The agent tools: the session banner and what the live region says of an
  // assistant's work. Every counted text pairs `{base}One` with `{base}`, the way `.plural` reads them.
  agentBannerLabel: "Assistant",
  agentBanner: "An assistant is working on this form: {{purpose}}",
  agentStop: "Stop",
  agentAllowAgain: "Allow the assistant again",
  agentUndoAll: "Undo all",
  agentDismiss: "Dismiss",
  agentSessionStarted: "An assistant started working on this form: {{purpose}}. Press Stop to take over.",
  agentSessionEnded: "The assistant finished: {{summary}}",
  agentStopped: "The assistant was stopped; {{count}} changes were undone",
  agentStoppedOne: "The assistant was stopped; {{count}} change was undone",
  agentPaused: "The assistant paused",
  agentFilled: "An assistant filled {{count}} fields",
  agentFilledOne: "An assistant filled {{count}} field",
  agentRowsAdded: "An assistant added {{count}} rows to {{label}}",
  agentRowsAddedOne: "An assistant added {{count}} row to {{label}}",
  agentRowRemoved: "An assistant removed a row from {{label}}",
  agentMoved: "An assistant moved to {{title}}",
  agentLanguage: "An assistant switched the form to {{label}}",
  agentUndone: "{{count}} changes by the assistant were undone",
  agentUndoneOne: "{{count}} change by the assistant was undone",
  agentSubmitted: "An assistant submitted the form",
  // The saved draft and the PDF, and the ended banner's line when a draft restored
  // during the session left nothing before it to undo.
  agentDraftSaved: "An assistant saved your draft",
  agentDraftRestored: "An assistant restored your saved draft",
  agentDraftCleared: "An assistant deleted your saved draft",
  agentPdfDownloaded: "An assistant downloaded a PDF of the form",
  agentSessionEndedAfterRestore: "A saved draft replaced the answers; earlier changes cannot be undone."
};

/**
 * The engine's own wording of `key` for `locale`: the form's `texts` translation of it, else the
 * language pack's (both from `words`), else the English. `undefined` for a key the engine does
 * not word (a binding's own).
 */
export function defaultFormText(key: string, locale: string, words?: EngineWordSources): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_FORM_TEXTS, key)) {
    return undefined;
  }
  return engineWord(addressOf.formText(key), key, locale, words, "texts") ?? DEFAULT_FORM_TEXTS[key as EngineFormTextKey];
}

/** Values for a text's `{{name}}` placeholders. */
export type FormTextParams = Readonly<Record<string, string | number>>;

/** `template` with each `{{name}}` the params name replaced; one they do not is left as it is. */
export function fillFormText(template: string, params?: FormTextParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/**
 * The sources of the engine's words beside the page's and the binding's: `words`, with `catalog`
 * (the host's translations, a resolver's older third argument) standing in when `words` names
 * none. `undefined` when there are none.
 */
function wordSourcesOf(catalog: TranslationCatalog | undefined, words: EngineWordSources | undefined): EngineWordSources | undefined {
  if (catalog === undefined || words?.catalog !== undefined) {
    return words;
  }
  return { ...words, catalog };
}

/** One layer of a text's wording: what it says for `key` in the resolver's locale, or `undefined`. */
type TextLayer = (key: string) => string | undefined;

/** The four layers above the engine's English, in order: page, `texts` translations, binding, pack. */
function textLayers(
  texts: FormTextCatalog | undefined,
  locale: string,
  bindingTexts: FormTextCatalog | undefined,
  sources: EngineWordSources | undefined
): { page: TextLayer; rest: TextLayer[] } {
  return {
    page: (key) => resolveLocalizedText(texts?.[key], locale),
    rest: [
      (key) => (sources ? lookupText(addressOf.formText(key), locale, sources) : undefined),
      (key) => resolveLocalizedText(bindingTexts?.[key], locale),
      (key) => packText(sources?.pack?.texts, locale, key)
    ]
  };
}

function firstWording(layers: readonly TextLayer[], key: string): string | undefined {
  for (const layer of layers) {
    const hit = layer(key);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/**
 * The text for `key` in `locale`: the page's entry resolved from its own words, else the form's
 * `texts` translation (`words.translations`, and the host's `catalog` over it), else the
 * drawing's, else the language pack's (`words.pack`), else the engine's English — the key itself
 * for a drawing key nobody worded — with its placeholders filled.
 */
export function resolveFormText(
  texts: FormTextCatalog | undefined,
  key: FormTextKey,
  locale: string,
  catalog?: TranslationCatalog,
  bindingTexts?: FormTextCatalog,
  params?: FormTextParams,
  words?: EngineWordSources
): string {
  const { page, rest } = textLayers(texts, locale, bindingTexts, wordSourcesOf(catalog, words));
  const layers = [page, ...rest];
  const worded = firstWording(layers, key);
  // A layer that words the heading but not its singular keeps its one wording for the count of
  // one too ("There is a problem" has no plural to split).
  if (key === "summaryHeadingOne" && worded === undefined) {
    const heading = firstWording(layers, "summaryHeading");
    if (heading !== undefined) {
      return fillFormText(heading, params);
    }
  }
  return fillFormText(worded ?? (Object.prototype.hasOwnProperty.call(DEFAULT_FORM_TEXTS, key) ? DEFAULT_FORM_TEXTS[key as EngineFormTextKey] : key), params);
}

/** The plural category of `count` in `locale` (`zero`, `one`, `two`, `few`, `many`, `other`); English rules for a tag Intl cannot read. */
function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale.replace(/_/g, "-")).select(count);
  } catch {
    return new Intl.PluralRules("en").select(count);
  }
}

/** The keys a counted text falls back to when no `base.category` key is worded: the singular's and the general one. */
export interface PluralFallbackKeys {
  one?: FormTextKey;
  other?: FormTextKey;
}

/**
 * A counted text for `count`: `base.<category>` (the locale's `Intl.PluralRules` category, so
 * `countLeft.few` for Polish) in the page's texts, then the form's `texts` translations, the
 * drawing's and the pack's; a category nobody worded reads `base.other`. Without those it is the
 * two-key pair (`{base}One` for the category `one`, `base` otherwise, or the keys `fallback`
 * names), the shape the engine's English is kept in, which stands behind them.
 */
export function resolveFormTextPlural(
  texts: FormTextCatalog | undefined,
  base: string,
  count: number,
  locale: string,
  catalog?: TranslationCatalog,
  bindingTexts?: FormTextCatalog,
  params?: FormTextParams,
  fallback?: PluralFallbackKeys,
  words?: EngineWordSources
): string {
  const category = pluralCategory(locale, count);
  // The two-key pair the engine's English is kept in: `{base}One` (or `fallback.one`) for one, `base` (or `fallback.other`) otherwise.
  const pairKey = category === "one" ? (fallback?.one ?? `${base}One`) : (fallback?.other ?? base);
  const keys = category === "other" ? [`${base}.other`] : [`${base}.${category}`, `${base}.other`];
  // The page's plain base also reads for the count of one (a page that words `summaryHeading`
  // means it for every count), and it does so before any other layer's key, a singular included.
  const pageKeys = category === "one" ? [...keys, pairKey, base] : [...keys, pairKey];
  const { page, rest } = textLayers(texts, locale, bindingTexts, wordSourcesOf(catalog, words));
  for (const layer of [page, ...rest]) {
    for (const key of layer === page ? pageKeys : [...keys, pairKey]) {
      const hit = layer(key);
      if (hit !== undefined) {
        return fillFormText(hit, params);
      }
    }
  }
  return resolveFormText(texts, pairKey, locale, catalog, bindingTexts, params, words);
}

/** `resolveFormText` with the page's, the binding's, the engine's word sources and the locale already bound. */
export type FormTextResolver = {
  (key: FormTextKey, params?: FormTextParams): string;
  /** A counted text: see {@link resolveFormTextPlural}. */
  plural(base: string, count: number, params?: FormTextParams, fallback?: PluralFallbackKeys): string;
  /**
   * Where the engine's own words come from before its English (the form's `texts`
   * translations, the host's catalog, a language pack), for wording what the resolver does not:
   * a validation message (`resolveValidationMessage`'s `words`).
   */
  readonly words: EngineWordSources;
};

export function createFormTextResolver(
  locale: string,
  texts?: FormTextCatalog,
  catalog?: TranslationCatalog,
  bindingTexts?: FormTextCatalog,
  words?: EngineWordSources
): FormTextResolver {
  const sources = wordSourcesOf(catalog, words) ?? {};
  const resolver = ((key: FormTextKey, params?: FormTextParams) => resolveFormText(texts, key, locale, undefined, bindingTexts, params, sources)) as FormTextResolver & {
    words: EngineWordSources;
  };
  resolver.plural = (base, count, params, fallback) => resolveFormTextPlural(texts, base, count, locale, undefined, bindingTexts, params, fallback, sources);
  resolver.words = sources;
  return resolver;
}
