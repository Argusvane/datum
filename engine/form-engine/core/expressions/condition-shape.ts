import type { Expression } from "./expression.js";
import { FORMULA_FUNCTION_NAMES } from "./function-table.js";

/**
 * What a written condition looks like to the evaluator, before any answer is read: whether it
 * can run all the way down, and whether a path reads outside the form's answers. Shared by the
 * journey findings (`core/journey/journey-diagnostics.ts`) and a PDF layout's `when`
 * (`core/schema/pdf-layout.ts`), so a condition that one of them calls unusable the
 * other does too. Pure and dependency-free: the renderer's bundle carries it for the layout
 * choice, and nothing in it names a journey.
 */

const BINARY_OPERATORS: ReadonlySet<string> = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);
const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(["and", "or"]);
const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set(["add", "subtract", "multiply", "divide"]);

/**
 * Whether `value` is an expression the evaluator can run, all the way down. A shape check that
 * looks at the top-level `kind` only lets a hand-edited condition with a misspelt operator or a
 * missing operand through, and it would evaluate to `undefined` (or throw) rather than say what
 * was meant. A call must name a built-in or one of `knownFunctions` (the plugin functions the
 * host wired, as the parser's signatures name them); with none given, built-ins only.
 */
export function isEvaluableExpression(value: unknown, knownFunctions?: Iterable<string>): value is Expression {
  const known =
    knownFunctions === undefined ? undefined : knownFunctions instanceof Set ? (knownFunctions as ReadonlySet<string>) : new Set(knownFunctions);
  return evaluable(value, known);
}

function evaluable(value: unknown, known: ReadonlySet<string> | undefined): boolean {
  // An explicit stack, not recursion: a written condition of thousands of terms is a tree
  // thousands deep, and the check must answer for it rather than overflow.
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    const node = current as Record<string, unknown>;
    switch (node.kind) {
      case "literal":
        if (
          !(
            node.value === null ||
            typeof node.value === "string" ||
            typeof node.value === "number" ||
            typeof node.value === "boolean"
          )
        ) {
          return false;
        }
        break;
      case "path":
        if (!(typeof node.path === "string" && node.path.length > 0)) {
          return false;
        }
        break;
      case "unary":
        if (node.operator !== "not") {
          return false;
        }
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic": {
        const operators =
          node.kind === "binary" ? BINARY_OPERATORS : node.kind === "logical" ? LOGICAL_OPERATORS : ARITHMETIC_OPERATORS;
        if (!(typeof node.operator === "string" && operators.has(node.operator))) {
          return false;
        }
        stack.push(node.left, node.right);
        break;
      }
      case "call":
        if (
          !(
            typeof node.name === "string" &&
            (FORMULA_FUNCTION_NAMES.has(node.name) || (known !== undefined && known.has(node.name))) &&
            Array.isArray(node.args)
          )
        ) {
          return false;
        }
        for (const arg of node.args) {
          stack.push(arg);
        }
        break;
      case "if": {
        if (!Array.isArray(node.cases)) {
          return false;
        }
        for (const entry of node.cases) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
          }
          stack.push((entry as Record<string, unknown>).when, (entry as Record<string, unknown>).then);
        }
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** A path read from outside the form's answers: an entry's, an ancestor's, the host's or the component's own. */
export function isScopedExpressionPath(path: string): boolean {
  return (
    path === "component" ||
    path.startsWith("component.") ||
    path.startsWith("row.") ||
    path.startsWith("ancestor.") ||
    path.startsWith("host.")
  );
}
