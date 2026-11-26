/**
 * The visual table's grid: its limits, the spec read from a `pdf-table` node's
 * configuration, and the slot ids of its cells. Split out of pdf-layout.ts: the form's
 * generic tree walk names the slots of a `pdf-table` node, so this is the one slice of the PDF
 * schema every bundle carries, beside the layout reader in pdf-layout-read.ts.
 */
import type { ComponentNode } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A visual table whose cells are slots. */
export const PDF_TABLE_COMPONENT_TYPE = "pdf-table";

// --- Visual table: cells are slots -------------------------------------------------------

/** Largest grid a visual table may be: past this the cells are too small to hold anything. */
export const PDF_TABLE_MAX_ROWS = 50;
export const PDF_TABLE_MAX_COLUMNS = 12;

export interface PdfTableSpec {
  rows: number;
  columns: number;
  /** The first row is a header row (bold, repeated when the table breaks across pages). */
  header: boolean;
  /**
   * Bind the table to a collection: the first non-header row is the template repeated once
   * per collection row, the rest are ignored. Absent: every authored row is drawn once.
   */
  collectionPath?: string;
  /** Column widths as fractions of the table width, one per column; absent: equal columns. */
  widths?: number[];
  borders: "all" | "horizontal" | "none";
}

function clampCount(value: unknown, fallback: number, max: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(number)));
}

/** Reads a `pdf-table`'s configuration with defaults filled in; never throws. */
export function readPdfTableSpec(configuration: unknown): PdfTableSpec {
  const record = isRecord(configuration) ? configuration : {};
  const columns = clampCount(record.columns, 2, PDF_TABLE_MAX_COLUMNS);
  const rows = clampCount(record.rows, 2, PDF_TABLE_MAX_ROWS);
  const rawWidths = Array.isArray(record.widths) ? record.widths : undefined;
  const widths =
    rawWidths && rawWidths.length === columns && rawWidths.every((w) => typeof w === "number" && w > 0)
      ? (rawWidths as number[])
      : undefined;
  const collectionPath =
    typeof record.collectionPath === "string" && record.collectionPath.trim() !== ""
      ? record.collectionPath
      : undefined;
  return {
    rows,
    columns,
    header: record.header !== false,
    ...(collectionPath ? { collectionPath } : {}),
    ...(widths ? { widths } : {}),
    borders:
      record.borders === "horizontal" || record.borders === "none" ? record.borders : "all"
  };
}

/** The slot id of the cell at 1-based `row`, `column`: `r1c1` is the top-left cell. */
export function pdfTableSlotId(row: number, column: number): string {
  return `r${row}c${column}`;
}

/** Every cell slot, row-major, as the table's configuration declares them. */
export function pdfTableSlotIds(configuration: unknown): string[] {
  const spec = readPdfTableSpec(configuration);
  const out: string[] = [];
  for (let row = 1; row <= spec.rows; row += 1) {
    for (let column = 1; column <= spec.columns; column += 1) {
      out.push(pdfTableSlotId(row, column));
    }
  }
  return out;
}