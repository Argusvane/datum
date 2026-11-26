/**
 * An answer as the text a surface draws for it, or `""` when the answer is not a scalar.
 *
 * An answer arrives from the host (`setValues`, a stored draft) and the runtime keeps what it is
 * given, so a text field can hold an object. `String()` on an object either draws it as
 * `[object Object]` or, when it carries its own `toString`/`valueOf` keys or has no prototype,
 * throws and takes the whole paint with it. Only strings, numbers, booleans and bigints are text;
 * anything else draws empty and is left for validation to judge.
 */
export function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
    ? String(value)
    : "";
}
