/** Whether a `pattern` is a regular expression this runtime can actually compile. */
export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}
