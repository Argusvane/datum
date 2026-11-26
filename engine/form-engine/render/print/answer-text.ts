import type { PrintField } from "./model.js";

// Its own module: the print themes a page imports eagerly (basicPrintTheme) read it, and the print
// model it would otherwise sit in loads with print() (render/web-component/print-pipeline.ts).

/** A field's answer as one line, for a table cell (a filled date as the locale words it). */
export function printAnswerText(field: PrintField): string {
  const answer = field.answer;
  if (answer.shape === "text") {
    return answer.text;
  }
  if (answer.shape === "choices") {
    return answer.options
      .filter((option) => option.chosen)
      .map((option) => option.label)
      .join(", ");
  }
  if (answer.shape === "files") {
    return answer.names.join(", ");
  }
  return answer.text ?? "";
}
