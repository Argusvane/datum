/**
 * An answer as the text an export or a count shows for it. A store holds what a host put there, so
 * an answer can be any JSON-shaped value, or worse: `String()` on an object whose own `toString`
 * is not a function throws and takes the whole export with it. Strings, numbers, booleans and
 * bigints are their text; an object or a list is its JSON (empty when it cannot be written, a
 * cycle or a bigint inside); anything else (null, undefined) is empty.
 */
export function answerText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  return "";
}
