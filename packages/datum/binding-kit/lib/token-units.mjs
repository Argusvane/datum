// Token units, browser-safe (no node imports): what a binding's print theme and PDF theme may do
// with a design-system token value. The units a token contract (tokens.mjs) may name, the
// classification of a CSS value, and the converter to PDF points, which refuses anything but
// px, rem and pt: a token in em, %, vw or calc() has no fixed length on paper, so a converter that
// guessed would put a wrong number in a PDF.

/** The units a contract entry may declare. `any` skips the unit comparison against the release. */
export const UNITS = ["px", "rem", "pt", "color", "number", "font-family", "shadow", "any"];

export class TokenUnitError extends Error {}

const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|pt)$/;
const OTHER_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(em|ex|ch|vw|vh|vmin|vmax|%|cm|mm|in|pc|q)$/i;

/** The unit a CSS value is written in: one of UNITS, or `other` for what the contract cannot name. */
export function unitOf(value) {
  const text = String(value).trim();
  const length = LENGTH.exec(text);
  if (length) return length[2];
  if (/^#[0-9a-f]{3,8}$/i.test(text) || /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i.test(text) || /^(transparent|currentcolor)$/i.test(text)) return "color";
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return "number";
  if (/^(["'][^"']+["']|[a-z][\w -]*)(\s*,\s*(["'][^"']+["']|[a-z][\w -]*))*$/i.test(text) && /[a-z]/i.test(text) && !/^\d/.test(text) && !/^(inherit|initial|unset|none|auto|normal|bold|italic)$/i.test(text)) return "font-family";
  if (/(^|\s)(-?[\d.]+(px|rem|em)\s+){2,}.*(rgb|#|hsl)/i.test(text) || /^(inset\s+)?-?[\d.]+(px|rem)\s+-?[\d.]+(px|rem)/.test(text)) return "shadow";
  return "other";
}

/**
 * A length in px, rem or pt as PDF points. `remPt` is what 1rem is on paper (the design system's
 * root size at 0.75 pt per px: 16px root is 12 pt). Any other unit throws TokenUnitError naming
 * the value (and the token, when given): em, %, calc() and the viewport units have no fixed length
 * on a page.
 */
export function lengthToPt(value, { remPt = 12, token } = {}) {
  const text = String(value).trim();
  const where = token ? ` (token ${token})` : "";
  const match = LENGTH.exec(text);
  if (!match) {
    const other = OTHER_LENGTH.test(text) || /^calc\(|^var\(|^clamp\(|^min\(|^max\(/i.test(text);
    throw new TokenUnitError(`${other ? "unit not allowed" : "not a length"}: "${text}"${where}: a PDF theme takes px, rem or pt only`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "pt": return amount;
    case "px": return amount * 0.75;
    default: return amount * remPt;
  }
}

/**
 * The listed tokens a root does not define: `read(name)` returns the token's value on the element
 * the print or tier-2 CSS is drawn under (`getComputedStyle(el).getPropertyValue`), an empty
 * string where it is unset. A print theme's selfCheck returns one problem per name.
 */
export function missingTokens(contract, read) {
  return contract.tokens.filter((entry) => String(read(entry.name) ?? "").trim() === "").map((entry) => entry.name);
}
