import { guardSpreadsheetCell } from "@argusvane/datum-engine";
import type { FieldDescriptor } from "../aggregate/field-index.js";
import { answerText } from "../answer-text.js";
import { recordValuesOf } from "../record-values.js";
import type { SubmissionRecord } from "../types.js";

/**
 * Records as a table: one row per record, the record's own columns first — id,
 * received, status, locale, version, source, digest — then one column per field of the form,
 * by value path, read from the answers the verdict judged (`recordValuesOf`). RFC
 * 4180 quoting; a list answer joins its entries with `|`; an object answer is JSON. What a
 * spreadsheet opens, and what a script reads back without a parser of its own.
 *
 * A spreadsheet runs a cell that leads with `=`, `+`, `-`, `@`, a tab or a line break as a
 * formula, and an answer is whatever a visitor typed. So every cell that is text (an answer, a
 * record column, a column heading) gets the apostrophe the translation exchange writes, by the
 * same rule (`guardSpreadsheetCell`). A number or a boolean answer was never typed text: it is
 * written as it is, so a negative number stays a number.
 */
export const RECORD_COLUMNS = ["id", "receivedAt", "status", "locale", "formVersion", "source", "digest"] as const;

/** One answer as cell text: only a string is guarded, as a number or a boolean cannot lead with a formula the visitor chose. */
function entry(value: unknown): string {
  return typeof value === "string" ? guardSpreadsheetCell(value) : answerText(value);
}

/** A list is one cell, and a spreadsheet reads the cell by its first character: a list led by a non-string entry is guarded as a whole. */
function cell(value: unknown): string {
  if (!Array.isArray(value)) {
    return entry(value);
  }
  const text = value.map(entry).join("|");
  return typeof value[0] === "string" ? text : guardSpreadsheetCell(text);
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function valueAt(values: Record<string, unknown>, path: string): unknown {
  if (path in values) {
    return values[path];
  }
  let current: unknown = values;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function recordsToCsv(records: readonly SubmissionRecord[], fields: readonly FieldDescriptor[]): string {
  const header = [...RECORD_COLUMNS, ...fields.map((field) => field.valuePath)].map(guardSpreadsheetCell).map(quote).join(",");
  const rows = records.map((record) => {
    const values = recordValuesOf(record);
    const own = [record.id, record.receivedAt, record.status, record.locale, record.formVersion, record.source, record.digest];
    return [...own.map(guardSpreadsheetCell), ...fields.map((field) => cell(valueAt(values, field.valuePath)))].map(quote).join(",");
  });
  return `${[header, ...rows].join("\r\n")}\r\n`;
}

/** The records as JSON: the record columns and the answers the verdict judged, one object per record, pretty-printed. */
export function recordsToJson(records: readonly SubmissionRecord[]): string {
  return `${JSON.stringify(
    records.map((record) => ({
      id: record.id,
      receivedAt: record.receivedAt,
      status: record.status,
      locale: record.locale,
      formId: record.formId,
      formVersion: record.formVersion,
      source: record.source,
      digest: record.digest,
      values: recordValuesOf(record),
      ...(record.pdf ? { pdf: { fileName: record.pdf.fileName, sha256: record.pdf.sha256, signed: record.pdf.signed } } : {})
    })),
    null,
    2
  )}\n`;
}
