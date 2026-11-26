/**
 * A spreadsheet runs a cell that leads with `=`, `+`, `-` or `@` (or a tab or a line break) as a
 * formula, so a CSV a person opens in one writes an apostrophe before such a cell, and a reader
 * of the same CSV takes it off again. Any apostrophes already leading such a cell count, so
 * `'=x` goes out as `''=x` and a text always comes back as it went out.
 *
 * One rule for every CSV Datum writes (the translation exchange, the submissions export), so the
 * two never disagree about what a guarded cell looks like.
 */
export const FORMULA_LEAD = /^'*[=+\-@\t\r\n]/;
const GUARDED_LEAD = /^'+[=+\-@\t\r\n]/;

/** `value` as it is written into a CSV cell: an apostrophe first when a spreadsheet would run it. */
export function guardSpreadsheetCell(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** The text a guarded cell was written from: the inverse of {@link guardSpreadsheetCell}. */
export function unguardSpreadsheetCell(value: string): string {
  return GUARDED_LEAD.test(value) ? value.slice(1) : value;
}
