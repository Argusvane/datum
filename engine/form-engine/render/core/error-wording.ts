import {
  layerValidationMessages,
  readValidationMessages,
  resolveValidationMessage,
  type ValidationMessageCatalog
} from "../../core/localization/validation-messages.js";
import {
  createFormTextResolver,
  fillFormText,
  type EngineFormTextKey,
  type FormTextCatalog,
  type FormTextResolver
} from "../../core/localization/form-texts.js";
import type { FormError } from "../../core/errors/form-error.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { addressOf, resolveText, type EngineWordSources, type FormTranslations, type LanguagePack, type TextSources } from "../../core/localization/translations.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import type { RenderCollectionRows, RenderComponentModel, RenderNotice } from "./component-model.js";

/**
 * Where a field's error words come from, beyond what the definition itself authors.
 * `messages` is the page's catalog: it sits on top of everything the form authors, for every
 * code it names, as the page's `translations` sit on top of the form's own. `texts` is the
 * page's form wording and `bindingTexts` the binding's beneath it; they word the errors no
 * catalog words (`error.<code>` form texts) and the summary's own sentences. `pack` is the
 * binding's language pack: its texts and messages by locale, under the form's `texts`
 * translations and over the engine's English.
 */
export interface ErrorWordingSources {
  messages?: ValidationMessageCatalog | undefined;
  texts?: FormTextCatalog | undefined;
  bindingTexts?: FormTextCatalog | undefined;
  pack?: LanguagePack | undefined;
}

/** Everything the wording of one render reads: the sources plus the language and the translations. */
export interface ComponentMessageOptions extends ErrorWordingSources {
  locale?: string | undefined;
  /** The definition's own translations (`FormDefinition.translations`). */
  translations?: FormTranslations | undefined;
  /** The host's translations; an entry there wins over the definition's for the same address. */
  translationCatalog?: TranslationCatalog | undefined;
}

/**
 * The message catalog each component's errors are worded from. What a component
 * authors in its own `messages` wins over what its containers author, up to the form root;
 * the page's catalog (`options.messages`) sits on top of all of them for every code it names,
 * and the form's words fill the codes the page leaves out. Resolved once per
 * component and memoized: the summary and the field ask about the same components.
 */
export interface ComponentMessageResolver {
  /** The effective catalog for `model`; for the form's own errors, pass the root model. */
  forModel(model: RenderComponentModel | undefined): ValidationMessageCatalog | undefined;
}

export function createComponentMessageResolver(
  output: { readonly components: readonly RenderComponentModel[] },
  options: ComponentMessageOptions
): ComponentMessageResolver {
  // The form's texts (the page's over the theme's) word the errors no catalog words, when
  // there is a locale to word them in (see `withWordedErrors`).
  const text =
    options.locale !== undefined
      ? createFormTextResolver(options.locale, options.texts, options.translationCatalog, options.bindingTexts, { translations: options.translations, pack: options.pack })
      : undefined;
  const modelsById = new Map(output.components.map((model) => [model.id, model]));
  const authored = new Map<string, ValidationMessageCatalog | undefined>();
  const authoredFor = (model: RenderComponentModel): ValidationMessageCatalog | undefined => {
    if (authored.has(model.id)) {
      return authored.get(model.id);
    }
    const parent = model.parentId !== undefined ? modelsById.get(model.parentId) : undefined;
    // A component's own messages are worded for the locale here, from the definition's map and
    // the host's catalog, so what is layered below is finished text. The form
    // root's are the form's own (`form › messages › <code>`). Without a locale they stay in the
    // default language.
    const own = readValidationMessages(
      model.node.configuration,
      options.locale !== undefined
        ? {
            ...(model.parentId !== undefined ? { ownerId: model.id } : {}),
            locale: options.locale,
            sources: { translations: options.translations, catalog: options.translationCatalog }
          }
        : undefined
    );
    const layered = layerValidationMessages(own, parent ? authoredFor(parent) : undefined);
    authored.set(model.id, layered);
    return layered;
  };
  return {
    forModel(model) {
      const fromForm = model ? authoredFor(model) : undefined;
      const catalog = layerValidationMessages(options.messages, fromForm);
      return model && text ? withWordedErrors(catalog, model, text) : catalog;
    }
  };
}

/**
 * `catalog` with an entry for each of `model`'s errors that neither the catalog nor the error
 * itself words, taken from the form's texts: `error.<code>.<missingKey>` for a date typed in
 * part, then `error.<code>.<type>` for the component's type, else `error.<code>` — a theme's (or a page's) wording built from the field's label, as a
 * design system's error-message templates are ("Enter {{label}}", "{{Label}} must be
 * {{maxLength}} characters or less"). `{{label}}` is the label as it reads mid-sentence (its
 * first letter lower-cased unless its first word is an acronym), `{{Label}}` as written, and
 * the error's parameters fill their own names. Authored words always win: a component's,
 * its containers' and the page's `messages`, and a message the error carries (a pattern's).
 * With no such text the catalog is returned as it was, and the engine's own fallback applies.
 */
function withWordedErrors(
  catalog: ValidationMessageCatalog | undefined,
  model: Pick<RenderComponentModel, "errors" | "label" | "type">,
  text: FormTextResolver
): ValidationMessageCatalog | undefined {
  let filled: ValidationMessageCatalog | undefined;
  for (const error of model.errors) {
    if ((filled ?? catalog)?.[error.code] !== undefined || error.message !== undefined || error.parameters?.message !== undefined) {
      continue;
    }
    const params: Record<string, string | number> = { label: labelInSentence(model.label), Label: model.label };
    for (const [name, value] of Object.entries(error.parameters ?? {})) {
      if (typeof value === "string" || typeof value === "number") {
        params[name] = value;
      }
    }
    // A date typed in part is worded per missing part first (`error.dateIncomplete.month-year`):
    // a language whose words for the parts `{{missing}}` cannot carry names them itself.
    const missingKey = error.parameters?.missingKey;
    const worded = [...(typeof missingKey === "string" ? [`error.${error.code}.${missingKey}`] : []), `error.${error.code}.${model.type}`, `error.${error.code}`]
      .map((key) => ({ key, value: text(key, params) }))
      .find((entry) => entry.value !== entry.key)?.value;
    if (worded !== undefined) {
      filled = { ...(filled ?? catalog ?? {}), [error.code]: worded };
    }
  }
  return filled ?? catalog;
}

/**
 * What an error on a component reads with no author's or host's words: the engine's own sentence
 * (or its translation through the form's `texts › messages`), else a binding's language pack or a
 * theme's `error.<code>` text, built from the field's label as the real wording would be. Never a
 * `messages` entry (the field's, a container's, the form's, the page's), a message the error
 * carries, or an `error.<code>` text of the form's translations or the page's texts. The error
 * summary compares an entry's message with it: a message that reads otherwise was written for the
 * error (`ErrorSummaryEntry.authored`).
 */
export function createDefaultMessageWording(options: ComponentMessageOptions): (model: RenderComponentModel, error: FormError) => string {
  const locale = options.locale ?? "en";
  const text = createFormTextResolver(locale, undefined, undefined, options.bindingTexts, { pack: options.pack });
  const words: EngineWordSources = { translations: options.translations, catalog: options.translationCatalog, pack: options.pack };
  return (model, error) => {
    // The error as the engine raised it, without the words a raiser or an author put on it.
    const { message: _carried, parameters, ...raised } = error;
    const { message: _authored, ...bareParameters } = parameters ?? {};
    const bare: FormError = { ...raised, parameters: bareParameters };
    return resolveValidationMessage(bare, withWordedErrors(undefined, { errors: [bare], label: model.label, type: model.type }, text), locale, words);
  };
}

/**
 * A label as it reads inside a sentence: "Full name" → "full name". The first word keeps its
 * capital where lower-casing it would misspell it: the pronoun "I" ("I agree to the terms",
 * "I'm a carer"), a word with a capital after its first letter (an acronym, "NHS number";
 * "iPhone"), and the first of capitalised words — a proper noun ("National Insurance number").
 * Nothing after the first letter is ever lower-cased.
 */
export function labelInSentence(label: string): string {
  const trimmed = label.trim();
  const [first = "", second] = trimmed.split(/\s+/);
  const capitalised = (word: string | undefined): boolean => word !== undefined && /^\p{Lu}/u.test(word);
  if (/^I(?:['’]\p{L}+)?$/u.test(first) || /\p{Lu}/u.test(first.slice(1)) || (capitalised(first) && capitalised(second))) {
    return trimmed;
  }
  return trimmed.charAt(0).toLocaleLowerCase() + trimmed.slice(1);
}

/** Whether an error stops the form: severity `"error"`, the default. A warning or info is a notice. */
export function isBlockingError(error: Pick<FormError, "severity">): boolean {
  return (error.severity ?? "error") === "error";
}

/**
 * Words every model's errors in place, once the whole list is built (a message catalog layers
 * down the parent chain, so it needs every model): `errorMessages` for each blocking error
 * and `notices` for each warning or info, the template children of a collection-bound
 * container and every row's models alike. The catalogs are those of {@link createComponentMessageResolver}.
 */
export function wordComponentErrors(models: readonly RenderComponentModel[], options: ComponentMessageOptions): void {
  const locale = options.locale ?? "en";
  const resolver = createComponentMessageResolver({ components: models }, { ...options, locale });
  // The engine's own sentences in the locale: the form's `texts` translations, the host's over them.
  const words: EngineWordSources = { translations: options.translations, catalog: options.translationCatalog, pack: options.pack };
  const word = (model: RenderComponentModel): void => {
    if (model.errors.length > 0) {
      const catalog = resolver.forModel(model);
      model.errorMessages = model.blockingErrors.map((error) => resolveValidationMessage(error, catalog, locale, words));
      model.notices = model.errors
        .filter((error): error is FormError & { severity: "warning" | "info" } => !isBlockingError(error))
        .map(
          (error): RenderNotice => ({
            code: error.code,
            severity: error.severity,
            message: resolveValidationMessage(error, catalog, locale, words)
          })
        );
    }
    for (const entry of model.rows?.entries ?? []) {
      entry.forEach(word);
    }
  };
  models.forEach(word);
}

/**
 * A configuration caption a collection-bound container may carry (`addLabel`, `rowLabel`):
 * a string in the form's default language, worded for the locale at
 * `components › <id> › <key>`; `undefined` when unset or blank.
 */
export function containerCaptionOf(node: ComponentNode, key: string, locale: string, sources: TextSources): string | undefined {
  const configuration = node.configuration;
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return undefined;
  }
  const raw = (configuration as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? resolveText(raw, addressOf.component(node.id, key), locale, sources) : undefined;
}

/**
 * A row's heading by its 1-based number: the container's own `rowLabel` with `{{n}}` filled,
 * else the form text `dataGridRow` ("Row 2"). The row header cell and the error summary's
 * "Row 2: Quantity" entry word it the same way.
 */
export function rowHeadingOf(
  node: ComponentNode,
  n: number,
  locale: string,
  sources: TextSources,
  text: FormTextResolver
): string {
  const own = containerCaptionOf(node, "rowLabel", locale, sources);
  return own !== undefined ? fillFormText(own, { n }) : text("dataGridRow", { n });
}

/**
 * Every model drawn in a row of a collection-bound container, by its value path
 * (`items[1].sku`): what an error raised at an entry's key is shown against, in the summary
 * ("Row 2: Quantity") and when focus goes to it.
 */
export function rowModelsByValuePath(output: { readonly components: readonly RenderComponentModel[] }): Map<string, RenderComponentModel> {
  const out = new Map<string, RenderComponentModel>();
  const visit = (rows: RenderCollectionRows): void => {
    for (const entry of rows.entries) {
      for (const model of entry) {
        if (!out.has(model.valuePath)) {
          out.set(model.valuePath, model);
        }
        if (model.rows !== undefined) {
          visit(model.rows);
        }
      }
    }
  };
  for (const model of output.components) {
    if (model.rows !== undefined) {
      visit(model.rows);
    }
  }
  return out;
}

/** The row-drawn model an error belongs to: the one at the error's path, when it is an entry's key. */
export function rowModelOfError(rowModels: ReadonlyMap<string, RenderComponentModel>, error: FormError): RenderComponentModel | undefined {
  if (rowModels.size === 0 || error.path === undefined) {
    return undefined;
  }
  const model = rowModels.get(stringifyComponentPath(error.path));
  return model !== undefined && model.id === error.componentId ? model : undefined;
}

/**
 * The collection-bound container a cell error belongs to as a whole: an
 * error on a field of a grid's row template that no drawn row owns — raised at an index-free
 * path (`orders.pick`, `option.notAllowed` naming the refused cells in `parameters.keys`), or
 * at an entry the form does not draw. It is drawn under the grid's legend, and the summary and
 * the first-error focus go to the grid. `undefined` for an error a row owns, for the grid's own
 * and for any field outside a grid.
 */
export function gridOfCellError(
  componentsById: ReadonlyMap<string, RenderComponentModel>,
  rowModels: ReadonlyMap<string, RenderComponentModel>,
  error: FormError
): RenderComponentModel | undefined {
  if (error.componentId === undefined || rowModelOfError(rowModels, error) !== undefined) {
    return undefined;
  }
  const model = componentsById.get(error.componentId);
  if (model === undefined || model.rows !== undefined) {
    return undefined;
  }
  for (let id = model.parentId; id !== undefined; ) {
    const parent = componentsById.get(id);
    if (parent === undefined) {
      return undefined;
    }
    if (parent.rows !== undefined) {
      return parent;
    }
    id = parent.parentId;
  }
  return undefined;
}

/** Error codes the form's own texts word, so a theme or page localises them with the rest. */
export const CODE_FORM_TEXTS: Readonly<Record<string, EngineFormTextKey>> = {
  "journey.server-unavailable": "serverUnavailable"
};
