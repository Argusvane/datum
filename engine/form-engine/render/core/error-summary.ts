import { resolveValidationMessage } from "../../core/localization/validation-messages.js";
import {
  createFormTextResolver,
  defaultFormText,
  DEFAULT_FORM_TEXTS,
  fillFormText,
  type FormTextResolver
} from "../../core/localization/form-texts.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { TextSources } from "../../core/localization/translations.js";
import type { RenderComponentModel } from "./component-model.js";
import {
  CODE_FORM_TEXTS,
  createComponentMessageResolver,
  createDefaultMessageWording,
  gridOfCellError,
  isBlockingError,
  rowHeadingOf,
  rowModelOfError,
  rowModelsByValuePath,
  type ComponentMessageOptions
} from "./error-wording.js";

/**
 * One line of the error summary: a blocking error and the field it goes to, worded. The
 * drawing surface adds the link (`href`, focus); an agent tool, WebMCP and a form test read
 * the same entry without a DOM.
 */
export interface ErrorSummaryEntry {
  /**
   * The value path of the control the entry goes to: the row's control for an error at a data
   * grid's entry (`items[1].qty`), the grid for a cell error no row owns, else the field's own
   * path (its id when the render output does not carry the component).
   */
  targetPath: string;
  /** The component the entry goes to (the grid, for a cell error no row owns). */
  componentId: string;
  /** What the field is called in the entry: its label, with its row's heading in front inside a grid ("Row 2 - Quantity"). */
  label: string;
  /** The error's own wording; `undefined` for a component the render output does not carry. */
  message: string | undefined;
  /** The whole line, `message` and `label` put together by the `summaryEntry` form text. */
  text: string;
  /**
   * `message` was written for this error by the form or its host (a `messages` entry, a message
   * the error carries, an `error.<code>` text of the form's translations or the page's texts),
   * not a default wording (the engine's sentence, translated or not, a binding's language pack):
   * it reads otherwise than `createDefaultMessageWording` would. A summary that lists a specific
   * message alone and a generic one with its field's label reads it.
   */
  authored: boolean;
}

/** An error with no field to go to (a host's "the form could not be sent"), worded; listed ahead of the field entries, with nothing to focus. */
export interface ErrorSummaryFormEntry {
  message: string;
  /** What the summary says: the message alone, or — for an error on a field the page does not draw — the field's entry text. */
  text: string;
}

/** The summary as the render output carries it, blocking errors only. */
export interface ErrorSummaryWording {
  /** The summary's heading, counted over the blocking errors ("There is a problem" / "There are 3 problems"). */
  heading: string;
  formEntries: ErrorSummaryFormEntry[];
  entries: ErrorSummaryEntry[];
}

export interface ErrorSummaryInput {
  components: readonly RenderComponentModel[];
  /** The page's errors by component id (`RenderErrorSummary.byComponent`), in the order the summary lists them. */
  byComponent: Readonly<Record<string, number>>;
  /** The errors on the page's components, to count a component the render output does not carry. */
  fieldErrors: readonly FormError[];
  /** The errors with no field on the page. */
  formErrors: readonly FormError[];
  locale: string;
  wording: ComponentMessageOptions;
}

/**
 * Words the error summary: one entry per blocking error (a field failing two rules lists both
 * problems, each going to the same field), the form-level errors first. The same wording the
 * markup's summary uses, so a surface drawing from these entries says what the markup says.
 */
export function wordErrorSummary(input: ErrorSummaryInput): ErrorSummaryWording {
  const { components, locale } = input;
  const text: FormTextResolver = createFormTextResolver(locale, input.wording.texts, input.wording.translationCatalog, input.wording.bindingTexts, {
    translations: input.wording.translations,
    pack: input.wording.pack
  });
  const sources: TextSources = { translations: input.wording.translations, catalog: input.wording.translationCatalog };
  const messagesFor = createComponentMessageResolver({ components }, { ...input.wording, locale });
  const componentsById = new Map(components.map((model) => [model.id, model]));
  const rowModels = rowModelsByValuePath({ components });
  const rootModel = components.find((model) => model.parentId === undefined);
  const formMessages = messagesFor.forModel(rootModel);

  // An error on a component the page does not draw — one on another journey page, off the
  // journey's path, or a required field a presentation leaves out — is
  // listed as text, worded as its own field would word it and named by its label, since the
  // text is all the person gets of it. A code the form's texts word (a server that could not
  // be reached) takes that wording unless a catalog has one.
  const wordFormError = (error: FormError): ErrorSummaryFormEntry => {
    const model = error.componentId ? componentsById.get(error.componentId) : undefined;
    const catalog = model ? messagesFor.forModel(model) : formMessages;
    const textKey = Object.prototype.hasOwnProperty.call(CODE_FORM_TEXTS, error.code) ? CODE_FORM_TEXTS[error.code] : undefined;
    const message =
      textKey !== undefined && catalog?.[error.code] === undefined
        ? text(textKey)
        : resolveValidationMessage(error, catalog, locale, text.words);
    if (!model) {
      return { message, text: message };
    }
    // An entry worded without the field ("{{message}}": GOV.UK's summary repeats the inline
    // message, its link names the field) would name nothing here, where there is no link: the
    // engine's own entry names it instead ("Annual income: Enter an answer").
    const worded = text("summaryEntry", { label: model.label, message });
    // The engine's own entry: the form's or the language pack's wording where it names the field, else the English.
    const own = defaultFormText("summaryEntry", locale, text.words);
    return {
      message,
      text:
        worded !== text("summaryEntry", { label: "", message })
          ? worded
          : fillFormText(own !== undefined && own.includes("{{label}}") ? own : DEFAULT_FORM_TEXTS.summaryEntry, { label: model.label, message })
    };
  };
  const formEntries = input.formErrors.filter(isBlockingError).map(wordFormError);

  const entries: ErrorSummaryEntry[] = [];
  const defaultWording = createDefaultMessageWording({ ...input.wording, locale });
  for (const id of Object.keys(input.byComponent)) {
    const model = componentsById.get(id);
    if (!model) {
      // A counted error whose component the render output does not carry: name the field alone.
      if (input.fieldErrors.some((error) => error.componentId === id && isBlockingError(error))) {
        entries.push({ targetPath: id, componentId: id, label: id, message: undefined, text: id, authored: false });
      }
      continue;
    }
    const messages = model.errorMessages ?? [];
    model.blockingErrors.forEach((error, at) => {
      const message = messages[at];
      const wordedWith = (label: string): string => (message ? text("summaryEntry", { label, message }) : label);
      // Words written for this error read otherwise than the default wording would.
      const authored = message !== undefined && message !== defaultWording(model, error);
      const row = rowModelOfError(rowModels, error);
      if (row?.row !== undefined) {
        const owner = componentsById.get(row.row.ownerId)?.node;
        const heading = owner !== undefined ? rowHeadingOf(owner, row.row.index + 1, locale, sources, text) : text("dataGridRow", { n: row.row.index + 1 });
        const label = `${heading}${text("stepTagSeparator")}${model.label}`;
        entries.push({ targetPath: row.valuePath, componentId: id, label, message, text: wordedWith(label), authored });
        return;
      }
      // A cell error no row owns is the grid's to show: the entry goes to the
      // grid, still named by the field.
      const grid = gridOfCellError(componentsById, rowModels, error);
      if (grid !== undefined) {
        entries.push({ targetPath: grid.valuePath, componentId: grid.id, label: model.label, message, text: wordedWith(model.label), authored });
        return;
      }
      entries.push({ targetPath: model.valuePath, componentId: id, label: model.label, message, text: wordedWith(model.label), authored });
    });
  }
  const count = entries.length + formEntries.length;
  return { heading: text.plural("summaryHeading", count, { count }), formEntries, entries };
}
