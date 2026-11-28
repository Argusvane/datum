/**
 * The display text beside a value: what the person sees
 * for a stored answer, so an agent can read "Operations" next to `"ops"` and "October 2, 2026"
 * next to `"2026-10-02"`. Choices and files go through `formatPdfValue` (`render/pdf/
 * pdf-values.js`, core-only imports: it strips the bidi controls an answer may carry);
 * numbers and dates through `Intl`, each guarded, since no engine formatter exists for them.
 */

import { kernelIsDateAnswer } from "../../core/schema/answer-kinds.js";
import type { FormTextResolver } from "../../core/localization/form-texts.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";
import { formatPdfValue } from "../../render/pdf/pdf-values.js";
import { cutString } from "../result-caps.js";
import type { FieldKind } from "../../registry/kinds.js";

const DISPLAY_CAP = 2_000;

/** The yes / no words: the page's or theme's `yes` / `no` texts when worded, else the engine's for the locale. */
export function yesNoTexts(texts: FormTextResolver, locale: string): { yes: string; no: string } {
  const french = /^fr(?:[-_]|$)/iu.test(locale);
  const yes = texts("yes");
  const no = texts("no");
  return {
    yes: yes === "yes" ? (french ? "Oui" : "Yes") : yes,
    no: no === "no" ? (french ? "Non" : "No") : no
  };
}

export function formatNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function formatDate(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  } catch {
    return value;
  }
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * The text the person sees for `value` in `model`: option labels joined by ", ", the form's
 * yes / no, a formatted number or date, a file's `name (12 KB)`, `"{n} rows"` for a table,
 * the string itself for text. `""` when there is no answer.
 */
export function displayOf(
  model: RenderComponentModel,
  kind: FieldKind,
  value: unknown,
  locale: string,
  texts: FormTextResolver
): string {
  if (kind === "collection") {
    const count = Array.isArray(value) ? value.length : 0;
    return count === 1 ? "1 row" : `${count} rows`;
  }
  if (kind === "group" || kind === "signature") {
    return "";
  }
  if (isEmpty(value)) {
    return kind === "boolean" ? "" : "";
  }
  if (kind === "boolean") {
    return formatPdfValue(model, yesNoTexts(texts, locale), value, locale).text;
  }
  if (kind === "choice" || kind === "multichoice" || kind === "file") {
    return cutString(formatPdfValue(model, yesNoTexts(texts, locale), value, locale).text, DISPLAY_CAP);
  }
  if (kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return formatNumber(value, locale);
    }
    return typeof value === "string" ? value : "";
  }
  if (kind === "date") {
    return typeof value === "string" ? (kernelIsDateAnswer(value) ? formatDate(value, locale) : value) : "";
  }
  if (typeof value === "string") {
    return cutString(value, DISPLAY_CAP);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}
