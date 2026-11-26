import type { Report } from "./model.js";

/**
 * The report as JSON text, two-space indented, newline-terminated. The
 * model is the file's shape; `schema.ts` describes it for tools that validate a report before
 * they read it.
 */
export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
