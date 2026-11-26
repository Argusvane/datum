/**
 * Worded errors: a `FormError` the runtime raises carries a
 * code and sometimes a raw message; the person reads the wording the page's message catalogs,
 * the form's authored messages and the form texts give it. The agent reads the same text, in
 * the form's language, with the field's path and label beside it, so it can say what is wrong
 * in the person's words and fix the right field.
 */

import type { FormError } from "../../core/errors/form-error.js";
import type { FormTextCatalog } from "../../core/localization/form-texts.js";
import { resolveValidationMessage, type ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import type { TranslationCatalog } from "../../core/schema/contracts.js";
import type { FormTranslations, LanguagePack } from "../../core/localization/translations.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import { createComponentMessageResolver, type ComponentMessageResolver } from "../../render/core/error-wording.js";
import { cutString } from "../result-caps.js";
import type { PageContext, RenderMemo } from "./describe.js";

export interface WordedError {
  path?: string;
  id?: string;
  label?: string;
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  source: "client" | "wasm" | "server" | "custom";
  page?: string;
}

/** What the wording needs from the host and the runtime, read once per call. */
export interface MessageContext {
  locale: string;
  messages: ValidationMessageCatalog | undefined;
  texts: FormTextCatalog | undefined;
  translationCatalog: TranslationCatalog | undefined;
  /** The definition's own translations: a component's messages are worded for the locale through them. */
  translations: FormTranslations | undefined;
  /** The binding's language pack (`FormAgentHost.languagePack`): under the form's translations, over the engine's English. */
  pack: LanguagePack | undefined;
}

const MESSAGE_CAP = 500;
const LABEL_CAP = 200;

function resolverFor(memo: RenderMemo, context: MessageContext): ComponentMessageResolver {
  return createComponentMessageResolver(memo.output, {
    messages: context.messages,
    locale: context.locale,
    texts: context.texts,
    translationCatalog: context.translationCatalog,
    translations: context.translations,
    pack: context.pack
  });
}

/** Words one error the way the renderer does: the component's catalog layering, then the engine's defaults, in `locale`. */
export function wordError(error: FormError, memo: RenderMemo, resolver: ComponentMessageResolver, context: MessageContext, pages: PageContext | undefined): WordedError {
  const model = error.componentId !== undefined ? memo.modelById.get(error.componentId) : undefined;
  const text = resolveValidationMessage(error, resolver.forModel(model), context.locale, { translations: context.translations, catalog: context.translationCatalog, pack: context.pack });
  const worded: WordedError = {
    code: error.code,
    message: cutString(text, MESSAGE_CAP),
    severity: error.severity ?? "error",
    source: error.source
  };
  const path = error.path !== undefined ? stringifyComponentPath(error.path) : model?.valuePath;
  if (path !== undefined && path !== "") {
    worded.path = path;
  }
  if (error.componentId !== undefined) {
    worded.id = error.componentId;
  }
  if (model !== undefined) {
    worded.label = cutString(model.label, LABEL_CAP);
  }
  const page = pages !== undefined && error.componentId !== undefined ? pages.pageOf(error.componentId) : undefined;
  if (page !== undefined) {
    worded.page = page;
  }
  return worded;
}

/** Words a list of errors with one resolver (the catalogs are memoised per component inside it). */
export function wordErrors(errors: readonly FormError[], memo: RenderMemo, context: MessageContext, pages: PageContext | undefined): WordedError[] {
  if (errors.length === 0) {
    return [];
  }
  const resolver = resolverFor(memo, context);
  return errors.map((error) => wordError(error, memo, resolver, context, pages));
}
