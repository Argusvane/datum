/**
 * A condition in words: "Province equals “QC”", "Large print is checked / true", joined by
 * "and" or "or" for the shapes a sentence words, and the printed formula with field
 * labels for every other (`len(Applicants) > 2`). The Form panel's PDF group says in these
 * words which layout the answers choose; a journey's cards say a route's condition
 * the same way, and the flow map draws them as terms (`journey-components.ts`,
 * `journey-map-model.ts`, both over this module).
 *
 * A condition is read as stored: a formula string, a tree, or the object form
 * (`rule-source.ts`); one that does not parse, or cannot be evaluated, has no words, and the
 * caller says so ("a condition that never holds").
 *
 * Static and small: it rides in the builder's bundle beside `rules-model.ts`.
 */
import { isEvaluableExpression } from "../../core/expressions/condition-shape.js";
import type { Expression } from "../../core/expressions/expression.js";
import { printFormula } from "../formula/feel-print.js";
import { ruleExpression } from "./rule-source.js";

/** A condition as terms: each a field's label (its `subject`) and its test ("equals “QC”"), joined by `join`. */
export interface ConditionTerms {
  join: "and" | "or";
  /** A formula the sentence cannot word is one term: the printed formula as `subject`, with no `test`. */
  terms: Array<{ subject: string; test: string }>;
}

type Comparator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "isTrue" | "isFalse";

const COMPARATOR_WORDS: Readonly<Record<Comparator, string>> = {
  isTrue: "is checked / true",
  isFalse: "is unchecked / false",
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most"
};

interface SimpleTerm {
  path: string;
  comparator: Comparator;
  value: string;
}

function isComparison(operator: string): operator is Exclude<Comparator, "isTrue" | "isFalse"> {
  return ["eq", "neq", "gt", "gte", "lt", "lte"].includes(operator);
}

/** One row of the sentence: a bare path, a negated path, or a path compared with a literal. */
function simpleTerm(expression: Expression): SimpleTerm | undefined {
  if (expression.kind === "path") {
    return { path: expression.path, comparator: "isTrue", value: "" };
  }
  if (expression.kind === "unary" && expression.operand.kind === "path") {
    return { path: expression.operand.path, comparator: "isFalse", value: "" };
  }
  if (
    expression.kind === "binary" &&
    isComparison(expression.operator) &&
    expression.left.kind === "path" &&
    expression.right.kind === "literal"
  ) {
    const literal = expression.right.value;
    return { path: expression.left.path, comparator: expression.operator, value: literal === null ? "null" : String(literal) };
  }
  return undefined;
}

/**
 * The flat rows of a condition the sentence words: one row, or a chain of one logical
 * operator over rows. `undefined` for anything else (mixed and/or, two fields compared, a
 * function, arithmetic), which the printed formula says instead.
 */
function simpleRows(expression: Expression): { join: "and" | "or"; rows: SimpleTerm[] } | undefined {
  const single = simpleTerm(expression);
  if (single) {
    return { join: "and", rows: [single] };
  }
  if (expression.kind !== "logical") {
    return undefined;
  }
  const join = expression.operator;
  const rows: SimpleTerm[] = [];
  const visit = (node: Expression): boolean => {
    if (node.kind === "logical") {
      return node.operator === join && visit(node.left) && visit(node.right);
    }
    const row = simpleTerm(node);
    if (!row) {
      return false;
    }
    rows.push(row);
    return true;
  };
  return visit(expression) ? { join, rows } : undefined;
}

/**
 * `condition` as terms, each field named by `labelOf(path)` (else its path): the sentence's
 * rows for the shapes it words, else one term holding the printed formula with labels.
 * `undefined` for a condition the engine cannot evaluate at all (a formula that does not
 * parse, a misspelt tree), which a caller words itself ("a condition that never holds").
 */
export function conditionTerms(condition: unknown, labelOf: (path: string) => string | undefined): ConditionTerms | undefined {
  const expression = ruleExpression(condition);
  if (expression === undefined || !isEvaluableExpression(expression)) {
    return undefined;
  }
  const simple = simpleRows(expression);
  if (!simple) {
    return { join: "and", terms: [{ subject: printFormula(expression, { labelOf }), test: "" }] };
  }
  return {
    join: simple.join,
    terms: simple.rows.map((row) => ({
      subject: labelOf(row.path) ?? row.path,
      test: row.comparator === "isTrue" || row.comparator === "isFalse" ? COMPARATOR_WORDS[row.comparator] : `${COMPARATOR_WORDS[row.comparator]} “${row.value}”`
    }))
  };
}

/** One term's words: the subject and its test, or the formula alone. */
export function conditionTermText(term: { subject: string; test: string }): string {
  return term.test === "" ? term.subject : `${term.subject} ${term.test}`;
}

/**
 * `condition` in words, the terms of {@link conditionTerms} joined; `undefined` for a condition
 * the engine cannot evaluate.
 */
export function conditionInWords(condition: unknown, labelOf: (path: string) => string | undefined): string | undefined {
  const said = conditionTerms(condition, labelOf);
  return said?.terms.map(conditionTermText).join(said.join === "and" ? " and " : " or ");
}
