/**
 * Markup a print theme hands the renderer. A print theme draws strings, but never
 * raw ones: every drawer returns a {@link SafeHtml}, and the only way to make one is the
 * {@link printHtml} tag, which escapes every value it is given that is not already a `SafeHtml`.
 * A theme that forgets to escape an answer cannot: there is nothing to forget. A drawer that
 * returns a plain string is refused (the whole document is then printed with the basic theme),
 * so a third-party theme can never write a person's answer into the print document as markup.
 *
 * The brand is a module-private `WeakSet`, not a property: an object shaped like a `SafeHtml`
 * that this module did not make is not one.
 */

/** Markup made by {@link printHtml} (or by the renderer from markup the engine sanitized). */
export interface SafeHtml {
  /** The markup. Read it; never build one by hand (it would not be branded). */
  readonly html: string;
  toString(): string;
}

/** What {@link printHtml} takes between its literal parts. */
export type PrintHtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly PrintHtmlValue[];

const made = new WeakSet<object>();

function brand(html: string): SafeHtml {
  const value: SafeHtml = Object.freeze({
    html,
    toString: () => html
  });
  made.add(value);
  return value;
}

/** Whether `value` is markup this module made. */
export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === "object" && value !== null && made.has(value);
}

/** Escapes text for an HTML text node or an attribute value, single- or double-quoted. */
export function escapePrintText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function valueHtml(value: PrintHtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) {
    // `cond && printHtml\`…\``: a condition that fails draws nothing; `true` alone means nothing either.
    return "";
  }
  if (typeof value === "string") {
    return escapePrintText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => valueHtml(entry)).join("");
  }
  if (isSafeHtml(value)) {
    return value.html;
  }
  throw new TypeError("printHtml: a value is neither text, a number nor markup made by printHtml");
}

/**
 * The print themes' template tag: the literal parts as written, every value escaped unless it
 * is markup this tag made. Arrays are drawn entry by entry; `null`, `undefined` and booleans
 * draw nothing. Called other than as a tag (with a plain array for literal parts), it refuses.
 *
 * ```ts
 * printHtml`<p class="label">${field.label}</p>${field.hint && printHtml`<p>${field.hint}</p>`}`
 * ```
 */
export function printHtml(strings: TemplateStringsArray, ...values: readonly PrintHtmlValue[]): SafeHtml {
  if (!Array.isArray(strings) || !Array.isArray((strings as { raw?: unknown }).raw) || !Object.isFrozen(strings)) {
    throw new TypeError("printHtml is a template tag: printHtml`…`");
  }
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    out += valueHtml(values[index]) + (strings[index + 1] ?? "");
  }
  return brand(out);
}

/**
 * Markup the renderer trusts because the engine made it safe already: an `html` component's
 * content, which the render model holds run through `sanitizeStaticHtml`. Renderer-only: print
 * themes are handed it inside the model and never call this.
 */
export function trustedPrintHtml(html: string): SafeHtml {
  return brand(html);
}

/** Markup joined in order. */
export function joinPrintHtml(parts: readonly SafeHtml[]): SafeHtml {
  return brand(parts.map((part) => valueHtml(part)).join(""));
}
