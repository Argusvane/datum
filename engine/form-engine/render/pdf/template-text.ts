/**
 * Template text for a PDF: `"{{firstName}} {{lastName}}"`, `"Total: {{row.qty}}"`,
 * `"Page {{page}} of {{pages}}"`. The one place several answers are written into one block of
 * text, so a placeholder reads through the same scoped-path rules a rule expression does
 * (`row.`, `ancestor.`, `host.`, else form scope) — the rules evaluator does the reading.
 *
 * A placeholder resolves to the component's *formatted* value when the caller can format it
 * (an option's label rather than its stored key), else to the raw value as text. `{{page}}`
 * and `{{pages}}` stay tokens: only the kernel knows them, per page.
 *
 * The context is the evaluator's own: `today` beside `hostContext` lets an expression source
 * call `today()`, and `functions` carries the plugin functions it may call. An `if` with no
 * matching case and no `else` evaluates to no answer, which prints as "".
 */
import type { Expression } from "../../core/expressions/expression.js";
import { hasPlaceholders, scanPlaceholders } from "../../core/text/placeholders.js";
import { evaluateExpression, type RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import type { PdfTextRun } from "./pdf-document.js";
import { formatPdfPlainValue } from "./pdf-values.js";

export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "token"; token: "pageNumber" | "pageCount" };

export interface TemplateTextContext extends RuleEvaluationContext {
  /**
   * Formats a placeholder's value with what the caller knows about the path — the bound
   * component's option labels, a file's names. Return `undefined` to fall back to plain text.
   */
  formatPath?: (path: string, raw: unknown) => string | undefined;
}

export interface RenderedTemplateText {
  segments: TemplateSegment[];
  /** The text with tokens left as their placeholders (`{{page}}`), for previews and tests. */
  text: string;
  /** Placeholders that resolved to nothing. */
  unresolved: string[];
}

const PAGE_TOKENS: Record<string, TemplateSegment> = {
  page: { kind: "token", token: "pageNumber" },
  pages: { kind: "token", token: "pageCount" },
  pageNumber: { kind: "token", token: "pageNumber" },
  pageCount: { kind: "token", token: "pageCount" }
};

/**
 * Bare names a repeating region supplies about the current row. They live in the host scope
 * (`host.rowNumber`), but an author writing `{{rowNumber}}` should not have to know that.
 */
const ROW_ALIASES = new Set(["rowNumber", "rowIndex", "rowCount"]);

/** Whether the text holds any placeholder at all. */
export function hasTemplatePlaceholders(text: string): boolean {
  return hasPlaceholders(text);
}

export function renderTemplateText(template: string, context: TemplateTextContext): RenderedTemplateText {
  const segments: TemplateSegment[] = [];
  const unresolved: string[] = [];
  let text = "";
  const pushText = (value: string): void => {
    if (value.length === 0) {
      return;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === "text") {
      last.text += value;
    } else {
      segments.push({ kind: "text", text: value });
    }
    text += value;
  };
  for (const piece of scanPlaceholders(template)) {
    if ("text" in piece) {
      pushText(piece.text);
      continue;
    }
    const path = piece.path;
    const token = PAGE_TOKENS[path];
    if (token) {
      segments.push({ ...token });
      text += `{{${path}}}`;
      continue;
    }
    const scoped =
      ROW_ALIASES.has(path) && context.hostContext && Object.prototype.hasOwnProperty.call(context.hostContext, path)
        ? `host.${path}`
        : path;
    const raw = evaluateExpression({ kind: "path", path: scoped }, context);
    const formatted = context.formatPath?.(path, raw) ?? formatPdfPlainValue(raw);
    if (raw === undefined || raw === null) {
      unresolved.push(path);
    }
    pushText(formatted);
  }
  return { segments, text, unresolved };
}

/** Segments as runs, tokens carrying their page-number fallback text. */
export function templateSegmentsToRuns(segments: readonly TemplateSegment[]): PdfTextRun[] {
  return segments.map((segment) =>
    segment.kind === "text"
      ? { text: segment.text }
      : { text: segment.token === "pageNumber" ? "#" : "#", token: segment.token }
  );
}

/**
 * The regex cache a PDF's expressions evaluate under: it makes `matches` refuse a pattern of a
 * catastrophic shape built or written anywhere (a tree-written rule is never looked at by the
 * compile), unless the host allows risky patterns (`riskyPatterns: "allow"`). One per document or
 * per evaluator, so a pattern is analysed once.
 */
export function pdfRegexCache(riskyPatterns?: "refuse" | "allow" | undefined): Record<string, unknown> {
  return riskyPatterns === "allow" ? {} : { refuseRisky: true };
}

/** An authored expression's value as text; a failing expression is empty rather than fatal. */
export function evaluateTemplateExpression(expression: Expression, context: RuleEvaluationContext): string {
  try {
    return formatPdfPlainValue(evaluateExpression(expression, context));
  } catch {
    return "";
  }
}
