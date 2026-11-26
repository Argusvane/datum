import type { LocalizedText } from "../schema/contracts.js";
import type { FormError } from "../errors/form-error.js";
import { resolveLocalizedText } from "./localized-text.js";
import { addressOf, engineWord, resolveText, type EngineWordSources, type TextSources } from "./translations.js";

/**
 * Display text per error `code`, layered over the raw error. A catalog comes from two
 * places: the host page (`<datum-form messages>`, host data, so its values are
 * `LocalizedText`) and the form itself — the `messages` key of any component's configuration,
 * the form root's included, whose values are strings in the form's default language
 * that {@link readValidationMessages} words for a locale through the definition's map. See {@link layerValidationMessages} for how they combine.
 */
export type ValidationMessageCatalog = Record<string, LocalizedText>;

/** One validation code as the builder describes it: what it means, and the details a message may quote. */
export interface ValidationCodeDescription {
  code: string;
  /** What the code means, in a few words. */
  label: string;
  /** The `error.parameters` names a message for the code may put in braces. */
  parameters: readonly string[];
}

/**
 * The codes the engine's own field-constraints stage raises (`validation/core/field-constraints.ts`,
 * mirrored by `validation/wasm/portable-kernel.ts`), with the `{parameter}` tokens a message for
 * each may use. The builder offers these as suggestions; a catalog may name any other code too
 * — a server's, a sandboxed rule's — since a code is just the key an error carries.
 */
export const ENGINE_VALIDATION_CODES: ReadonlyArray<ValidationCodeDescription> = [
  { code: "required", label: "A required value is missing", parameters: [] },
  { code: "minLength", label: "Text is shorter than the minimum", parameters: ["minLength", "length"] },
  { code: "maxLength", label: "Text is longer than the maximum", parameters: ["maxLength", "length"] },
  { code: "pattern", label: "Text does not match the pattern", parameters: ["pattern"] },
  { code: "fileType", label: "A file's type is not accepted", parameters: ["file", "type", "accept"] },
  {
    code: "maxFileSize",
    label: "A file is larger than the limit",
    parameters: ["file", "sizeLabel", "maxFileSizeLabel", "size", "maxFileSize"]
  },
  // Raised by the validation kernel alone: an attachment whose declared size is negative or not a whole number.
  { code: "fileSize", label: "A file declares a size no file has", parameters: ["file", "size"] },
  // Inline bytes much larger than the declared size.
  { code: "file.sizeMismatch", label: "A file holds more bytes than it declares", parameters: ["file", "size", "actual"] },
  // A file answer is attachments, and no more than the field takes.
  { code: "file", label: "The answer is not an uploaded file", parameters: [] },
  { code: "fileCount", label: "More files than the field takes", parameters: ["count", "maxFiles"] },
  // A text answer is text.
  { code: "text", label: "The answer is not text", parameters: [] },
  // A number component's answer is a number, a date component's a real date.
  { code: "number", label: "The answer is not a number", parameters: [] },
  // A number or a date within its declared bounds, inclusive.
  { code: "number.min", label: "A number is below the minimum", parameters: ["min"] },
  { code: "number.max", label: "A number is above the maximum", parameters: ["max"] },
  { code: "date", label: "The answer is not a real date", parameters: [] },
  { code: "date.min", label: "A date is before the earliest allowed", parameters: ["min"] },
  { code: "date.max", label: "A date is after the latest allowed", parameters: ["max"] },
  { code: "dateIncomplete", label: "A date is missing a part", parameters: ["missing", "missingKey"] },
  // The field's Validate rule (`rules.validWhen`) does not hold.
  { code: "rule", label: "The answer fails the field's Validate rule", parameters: [] },
  // A data grid holds fewer rows than its minimum, or more than its maximum.
  { code: "rows.min", label: "Fewer rows than the minimum", parameters: ["min", "count"] },
  { code: "rows.max", label: "More rows than the maximum", parameters: ["max", "count"] }
];

/**
 * The engine's own wording for the codes it raises that no authored constraint does — a
 * number or a date that is not one, a journey's and the validation
 * sandbox's fail-closed backstop — for when neither a catalog nor the error itself words one,
 * so the person never reads a bare code. English only: another language comes from the form's
 * `texts` translations (`texts › messages › <code>`) or a binding's language pack, through
 * {@link defaultValidationMessage}; a page words them per locale through its `messages`, a form
 * through the root's, and either outranks these. The builder's Try it words an error from the
 * same table, so the renderer and the preview never differ.
 *
 * - `required`, `minLength`, `maxLength`, `pattern`, `fileType`, `maxFileSize`: the field's own
 *   declared limits, which no kernel words (a pattern's author-written message travels as the
 *   error's `message` and outranks this one).
 * - `number`: a number's answer is not a number, or its box holds text the browser cannot read.
 * - `date`: a date's answer is not a real calendar date.
 * - `dateIncomplete`: a date was typed in part (`{missing}` names the parts left, "month and year").
 * - `number.min`, `number.max`: a number outside the field's declared bounds (`{min}` / `{max}` is the bound).
 * - `date.min`, `date.max`: a date outside the field's declared bounds (`{min}` / `{max}` is the bound).
 * - `text`: a text or text area was sent an answer that is not text.
 * - `file`: a file field's answer is not an uploaded file (nothing the form could read as one).
 * - `fileCount`: more files than the field takes (`{maxFiles}` is how many it does).
 * - `fileSize`: the validation kernel's, for a file whose declared size no file has.
 * - `option.notAllowed`: a choice answer is not one of the options the field offers.
 * - `option.sourceUnavailable`: a choice's options come from a data source the server could not
 *   read when it checked, so the answer is refused rather than passed.
 * - `journey.server-unavailable`: the host's server could not be reached to check a page.
 * - `journey.exit`: the answers end the journey at an exit page, which sends nothing.
 * - `journey.unknown`: the submission names a journey the server's form does not have.
 * - `wasm.values-missing`: the sandbox passed the answers but handed none back to send.
 * - `fold.unsettled`: the form's rules keep flipping one another through the answers they
 *   hide, so there is no one set of answers to check; another answer settles them.
 * - `map.unsettled`: a presentation's worked-out values keep changing which of their own
 *   sources show, so there is no one value to send; another answer settles them.
 * - `validator.failed`: a plugin validator in the sandbox threw instead of answering, so the
 *   submission is refused rather than sent unchecked.
 * - `rule`: the field's Validate rule (`rules.validWhen`) does not hold; the author's
 *   own words are the field's `messages.rule`, which outranks this.
 * - `rows.min`, `rows.max`: a data grid holds fewer rows than its minimum or more than its
 *   maximum (`{min}` / `{max}` is the bound, `{count}` the rows it holds).
 */
export const DEFAULT_VALIDATION_MESSAGES: Readonly<Record<string, string>> = {
  required: "This field is required",
  minLength: "Enter at least {minLength} characters",
  maxLength: "Enter no more than {maxLength} characters",
  pattern: "Enter a value in the expected format",
  fileType: "{file} is not a type of file this field accepts",
  maxFileSize: "{file} is larger than the {maxFileSizeLabel} this field accepts",
  number: "Enter a number",
  date: "Enter a real date",
  dateIncomplete: "Enter a complete date",
  "number.min": "Enter a number of {min} or more",
  "number.max": "Enter a number of {max} or less",
  "date.min": "Enter a date on or after {min}",
  "date.max": "Enter a date on or before {max}",
  text: "Enter text",
  file: "Upload a file",
  fileCount: "Too many files: the most allowed is {maxFiles}",
  fileSize: "This file could not be read. Choose it again",
  "file.sizeMismatch": "This file could not be read. Choose it again",
  "option.notAllowed": "Choose one of the options offered",
  "option.sourceUnavailable": "This answer could not be checked. Try again later.",
  "journey.server-unavailable": "We could not check your answers. Try again.",
  "journey.exit": "You cannot send this form with these answers.",
  "journey.unknown": "This version of the form cannot be sent. Reload the page and try again.",
  "wasm.values-missing": "Your answers could not be checked. Try again.",
  "fold.unsettled": "Your answers could not be checked: some questions depend on each other. Change an answer and try again.",
  "map.unsettled": "Your answers could not be checked: some questions depend on each other. Change an answer and try again.",
  "validator.failed": "This answer could not be checked. Try again later.",
  rule: "Check this answer",
  "rows.min": "Too few rows: add at least {min}.",
  "rows.max": "Too many rows: at most {max}."
};

/**
 * The codes a host or a server may word itself: a field's declared limits. An error of one of
 * these that carries its own `message` (a pattern's author-written one, a server's through
 * `setErrors`) keeps it over the built-in sentence; the built-in only stands where nothing else
 * words the code. The other engine codes are the engine's to word (see {@link resolveValidationMessage}).
 */
const HOST_WORDED_CODES: ReadonlySet<string> = new Set(["required", "minLength", "maxLength", "pattern", "fileType", "maxFileSize"]);

/**
 * The engine's own sentence for `code` in `locale`, or `undefined` for a code it does not word:
 * the form's `texts` translation of it (`texts › messages › <code>`, the host catalog's over the
 * definition's map), else the language pack's, both from `words`, else the English. Not a
 * derived key of the form: nothing stores it.
 */
export function defaultValidationMessage(code: string, locale: string, words?: EngineWordSources): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_VALIDATION_MESSAGES, code)) {
    return undefined;
  }
  return engineWord(addressOf.engineMessage(code), code, locale, words, "messages") ?? DEFAULT_VALIDATION_MESSAGES[code];
}

/**
 * What a limit's code says when its raiser sent no parameters to fill the template with (a
 * server's `{ code: "minLength" }`): the same complaint without a number or file name in it.
 */
const PARAMETERLESS_WORDING: Readonly<Record<string, string>> = {
  minLength: "This answer is too short",
  maxLength: "This answer is too long",
  fileType: "This type of file is not accepted by this field",
  maxFileSize: "This file is too large for this field"
};

const ENGINE_CODE_SET: ReadonlySet<string> = new Set(ENGINE_VALIDATION_CODES.map((entry) => entry.code));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A host's text: a string, or an object with a string `default` and a word per locale. */
function isLocalizedText(value: unknown): value is LocalizedText {
  return typeof value === "string" || (isRecord(value) && typeof value.default === "string");
}

function parseMessages(value: unknown, accepts: (text: unknown) => text is LocalizedText): ValidationMessageCatalog | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const catalog: ValidationMessageCatalog = {};
  for (const [code, text] of Object.entries(value)) {
    if (code.trim().length > 0 && accepts(text)) {
      // Defined, not assigned: a code named `__proto__` is an entry, not a prototype.
      Object.defineProperty(catalog, code, { value: text, enumerable: true, writable: true, configurable: true });
    }
  }
  return Object.keys(catalog).length > 0 ? catalog : undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * A host's `messages` map (or a file of the same shape), keeping only the entries whose value is
 * text, a string or a `LocalizedText`. `undefined` for anything that is not a map, or a map with
 * no usable entry. A component's own `messages` are read by {@link readValidationMessages}.
 */
export function parseValidationMessageCatalog(value: unknown): ValidationMessageCatalog | undefined {
  return parseMessages(value, isLocalizedText);
}

/** What {@link readValidationMessages} needs to word a configuration's messages for a locale. */
export interface MessageTranslation {
  /** The component the configuration belongs to; absent for the form root, whose messages are the form's own. */
  ownerId?: string | undefined;
  locale: string;
  sources: TextSources;
}

/**
 * The messages a component's configuration authors: its `messages` map, plus the field's
 * `patternMessage` standing in for `pattern` when the map has no entry of its own.
 * `patternMessage` is a schema property of its own that the validation kernels carry as
 * `parameters.message`; reading it here is what lets it rank with the field's other messages
 * rather than below every catalog. Every value is a string in
 * the form's default language. With `translate`, each is worded for its locale
 * first, through the definition's map and the host's catalog at `addressOf.message(id, code)`
 * (`addressOf.formMessage(code)` on the root; the pattern's at `components › id › patternMessage`),
 * so a catalog layered from several owners holds finished text. `undefined` when the
 * configuration authors nothing usable.
 */
export function readValidationMessages(configuration: unknown, translate?: MessageTranslation): ValidationMessageCatalog | undefined {
  if (!isRecord(configuration)) {
    return undefined;
  }
  const catalog = parseMessages(configuration.messages, isString) ?? {};
  if (translate) {
    const { ownerId, locale, sources } = translate;
    for (const [code, text] of Object.entries(catalog) as Array<[string, string]>) {
      const address = ownerId === undefined ? addressOf.formMessage(code) : addressOf.message(ownerId, code);
      Object.defineProperty(catalog, code, { value: resolveText(text, address, locale, sources), enumerable: true, writable: true, configurable: true });
    }
  }
  if (catalog.pattern === undefined && typeof configuration.patternMessage === "string") {
    catalog.pattern =
      translate && translate.ownerId !== undefined
        ? resolveText(configuration.patternMessage, addressOf.component(translate.ownerId, "patternMessage"), translate.locale, translate.sources)
        : configuration.patternMessage;
  }
  return Object.keys(catalog).length > 0 ? catalog : undefined;
}

/**
 * One catalog from several, the earlier winning per code: the page's over the field's, a
 * field's over its container's over the form's. An
 * absent catalog contributes nothing; `undefined` when none had an entry.
 */
export function layerValidationMessages(
  ...catalogs: Array<ValidationMessageCatalog | undefined>
): ValidationMessageCatalog | undefined {
  let layered: ValidationMessageCatalog | undefined;
  for (const catalog of catalogs) {
    if (!catalog) {
      continue;
    }
    // Later catalogs only fill codes the earlier ones left empty.
    layered = layered ? { ...catalog, ...layered } : { ...catalog };
  }
  return layered && Object.keys(layered).length > 0 ? layered : undefined;
}

/**
 * Fills `{name}` tokens in a message from the error's `parameters` — "at least {minLength}
 * characters" becomes "at least 5 characters". Only a string or number parameter is written
 * in; a token naming anything else, or nothing, is left as authored, so a message never shows
 * "[object Object]" or silently loses a placeholder the host meant to see.
 */
function interpolate(message: string, parameters: Record<string, unknown> | undefined): string {
  if (!parameters) {
    return message;
  }
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name: string) => {
    const value = parameters[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : token;
  });
}

function parameterless(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PARAMETERLESS_WORDING, code) ? PARAMETERLESS_WORDING[code] : undefined;
}

/**
 * Resolves the display text for `error`: a catalog entry for its `code`, localized to
 * `locale` (a form's own entries arrive already worded, see {@link readValidationMessages}),
 * if one was supplied; otherwise, for a code the engine raises itself
 * ({@link ENGINE_VALIDATION_CODES}), the engine's wording ({@link DEFAULT_VALIDATION_MESSAGES})
 * then the error's own `message`; for any other code the `message` then the engine's wording
 * (a field's declared limits, `required` among them, take the `message` first); falling back
 * to its bare `code`, which only a code nothing words reaches. Either
 * text may carry `{parameter}` tokens filled from `error.parameters`. `words` is where the
 * engine's wording is read in another language (see {@link defaultValidationMessage}).
 */
export function resolveValidationMessage(
  error: Pick<FormError, "code" | "message"> & { parameters?: Record<string, unknown> | undefined },
  catalog: ValidationMessageCatalog | undefined,
  locale: string,
  words?: EngineWordSources
): string {
  const entry = catalog?.[error.code];
  const resolved = entry !== undefined ? resolveLocalizedText(entry, locale) : undefined;
  const engine = defaultValidationMessage(error.code, locale, words);
  // An engine-owned code is the engine's to word: a baked `message` (a kernel's, a server's)
  // is in whatever locale it was raised in, so the engine's wording outranks it. Any other
  // code is the raiser's own, and its `message` is the only wording there is.
  // The engine's wording only stands when the error carries what its tokens name: a raiser that
  // sends a code and a message without parameters is read by its message, not by a template
  // with holes.
  // The exception is a field's declared limits (`HOST_WORDED_CODES`): a message one of those
  // carries was written for it (a pattern's, a host's `setErrors`), so it outranks the built-in.
  const engineFits =
    engine !== undefined && !/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(interpolate(engine, error.parameters));
  const text = HOST_WORDED_CODES.has(error.code)
    ? (resolved ?? error.message ?? (engineFits ? engine : parameterless(error.code)) ?? error.code)
    : ENGINE_CODE_SET.has(error.code)
      ? (resolved ?? (engineFits ? engine : undefined) ?? error.message ?? engine ?? error.code)
      : (resolved ?? error.message ?? engine ?? error.code);
  return interpolate(text, error.parameters);
}
