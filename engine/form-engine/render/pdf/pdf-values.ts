/**
 * Turning a component's value into what a PDF prints.
 *
 * The read-only rendition's `displayValue` is not enough here: it stringifies a select's stored
 * value rather than showing its option label, and JSON-encodes anything that is not a string.
 * A PDF is read by someone with no form to look at, so it needs the label the person chose,
 * the checkboxes they ticked, and the names of the files they attached.
 */
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import type { LocalizedText } from "../../core/schema/contracts.js";
import { formatFileSize, readFileAttachments } from "../../core/schema/file-upload.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { scalarText } from "../core/scalar-text.js";

export interface PdfChoiceItem {
  value: string;
  label: string;
  checked: boolean;
  /** The option's hint (`InlineOption.description`), for a rendition with room for a second line. */
  description?: string;
}

export interface PdfFormattedValue {
  /** The value as text: option labels, joined lists, file names. Empty for no value. */
  text: string;
  /** For a choice component, every option with the picked ones marked. */
  items?: PdfChoiceItem[];
  /** For a single checkbox, whether it is ticked. */
  checked?: boolean;
  /** True when direction controls typed into the answer were removed ({@link stripAnswerBidi}); absent otherwise. */
  bidiStripped?: true;
  /** True when there is nothing to print. */
  empty: boolean;
}

export interface PdfValueTexts {
  yes: string;
  no: string;
}

/** Component types whose value is a yes or a no: the checkbox, and the `boolean` field a host registers. */
const YES_NO_TYPES = new Set(["checkbox", "boolean"]);

function isLocalizedObject(value: unknown): value is LocalizedText & object {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as { default?: unknown }).default === "string";
}

const DEFAULT_TEXTS: PdfValueTexts = { yes: "Yes", no: "No" };

const CHOICE_TYPES = new Set(["select", "radio", "checkboxes", "multiselect"]);

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function labelFor(model: RenderComponentModel, raw: unknown): string {
  const key = scalarText(raw);
  const item = model.optionState.items.find((candidate) => candidate.value === key);
  return item ? item.label : key;
}

/** The option values a choice component's value picks: one, several, or the ticked keys of a checkboxes object. */
function pickedValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined && entry !== null).map(scalarText);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, picked]) => picked === true)
      .map(([key]) => key);
  }
  return isEmptyValue(value) ? [] : [scalarText(value)];
}

/**
 * An answer's text without the direction controls that reorder what is drawn around it: the explicit embeddings and overrides (U+202A to U+202E) are
 * removed, and so is any isolate (U+2066 to U+2069) that is not closed (or a closer that opens
 * nothing), because an open isolate runs on over the author's text after the answer. A balanced
 * isolate is the proper way to write mixed-direction text and stays. Author text is never passed
 * through here.
 */
export function stripAnswerBidi(text: string): string {
  if (!/[\u202A-\u202E\u2066-\u2069]/.test(text)) {
    return text;
  }
  const kept: string[] = [];
  const open: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code >= 0x202a && code <= 0x202e) {
      continue;
    }
    if (code >= 0x2066 && code <= 0x2068) {
      open.push(kept.length);
    } else if (code === 0x2069) {
      if (open.length === 0) {
        continue;
      }
      open.pop();
    }
    kept.push(char);
  }
  for (const at of open) {
    kept[at] = "";
  }
  return kept.join("");
}

/**
 * Formats one component's value for paper. `value` defaults to the model's own; a repeating
 * region passes the row's value for the same component instead. The text never carries the
 * direction controls of {@link stripAnswerBidi}; `bidiStripped` says some were removed.
 */
export function formatPdfValue(
  model: RenderComponentModel,
  texts: PdfValueTexts = DEFAULT_TEXTS,
  value: unknown = model.value,
  locale?: string
): PdfFormattedValue {
  const formatted = formatPdfValueRaw(model, texts, value, locale);
  if (YES_NO_TYPES.has(model.type)) {
    return formatted;
  }
  const text = stripAnswerBidi(formatted.text);
  return text === formatted.text ? formatted : { ...formatted, text, bidiStripped: true };
}

function formatPdfValueRaw(
  model: RenderComponentModel,
  texts: PdfValueTexts = DEFAULT_TEXTS,
  value: unknown = model.value,
  locale?: string
): PdfFormattedValue {
  if (YES_NO_TYPES.has(model.type)) {
    const checked = value === true || value === "true";
    return { text: checked ? texts.yes : texts.no, checked, empty: false };
  }

  if (CHOICE_TYPES.has(model.type) || model.optionState.items.length > 0) {
    const picked = pickedValues(value);
    const items: PdfChoiceItem[] = model.optionState.items.map((item) => ({
      value: item.value,
      label: item.label,
      checked: picked.includes(item.value),
      ...(item.description ? { description: item.description } : {})
    }));
    const labels = picked.map((entry) => labelFor(model, entry));
    return { text: labels.join(", "), items, empty: picked.length === 0 };
  }

  if (model.type === "file") {
    const attachments = readFileAttachments(value);
    if (attachments.length > 0) {
      return {
        text: attachments
          .map((attachment) => `${attachment.name} (${formatFileSize(attachment.size)})`)
          .join(", "),
        empty: false
      };
    }
    return { text: "", empty: true };
  }

  if (isEmptyValue(value)) {
    return { text: "", empty: true };
  }
  if (typeof value === "string") {
    return { text: value, empty: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), empty: false };
  }
  if (Array.isArray(value)) {
    return { text: value.map((entry) => formatPlain(entry)).join(", "), empty: false };
  }
  if (isLocalizedObject(value)) {
    // An answer a host's field stores as `{ default, locales }` is the filler's data, not a text of
    // the definition: the reader gets their language's words, not the object.
    // A locale entry that is not text (a stored draft can hold anything) falls back to the default.
    const resolved = resolveLocalizedText(value, locale ?? "en");
    const text = typeof resolved === "string" ? resolved : value.default;
    return { text, empty: text === "" };
  }
  return { text: formatPlain(value), empty: false };
}

function formatPlain(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** A value that is not attached to any component (a template path, an expression result), as text. */
export function formatPdfPlainValue(value: unknown): string {
  if (Array.isArray(value)) {
    return stripAnswerBidi(value.map((entry) => formatPlain(entry)).join(", "));
  }
  return stripAnswerBidi(formatPlain(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The rows of a collection as the form state stores them — flat `collectionPath[i].field` keys
 * (see `FormStateStore.replaceCollectionValues`) — rebuilt as one object per row, in index
 * order with no gaps. A value stored whole as an array of objects under the path is accepted
 * too, which is how a submission hands rows back.
 */
export function readCollectionRows(
  values: Record<string, unknown>,
  collectionPath: string
): Array<Record<string, unknown>> {
  const whole = values[collectionPath];
  if (Array.isArray(whole) && whole.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    return whole.map((row) => ({ ...(row as Record<string, unknown>) }));
  }
  const pattern = new RegExp(`^${escapeRegExp(collectionPath)}\\[(\\d+)\\]\\.(.+)$`);
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(values)) {
    const match = pattern.exec(key);
    if (!match) {
      continue;
    }
    const index = Number(match[1]);
    const field = match[2]!;
    const row = byIndex.get(index) ?? {};
    row[field] = value;
    byIndex.set(index, row);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
