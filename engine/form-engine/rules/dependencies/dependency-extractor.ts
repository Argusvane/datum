import type { Expression } from "../../core/expressions/expression.js";

/**
 * Collects every path referenced by an expression. Scope prefixes are preserved
 * (`row.x`, `ancestor.y`, `component`, `host.z`) so callers can distinguish form-scoped
 * dependencies from contextual ones. The set is in reading order. Walks with an explicit stack:
 * a chain of ten thousand terms is a tree ten thousand deep, which a recursive walk cannot
 * survive.
 */
export function extractDependencies(expression: Expression): Set<string> {
  const out = new Set<string>();
  const stack: Expression[] = [expression];

  while (stack.length > 0) {
    const expr = stack.pop() as Expression;
    switch (expr.kind) {
      case "path":
        out.add(expr.path);
        break;

      case "unary":
        stack.push(expr.operand);
        break;

      case "binary":
      case "logical":
      case "arithmetic":
        // Pushed right first so the left is read first.
        stack.push(expr.right, expr.left);
        break;

      case "call":
        for (let i = expr.args.length - 1; i >= 0; i -= 1) {
          stack.push(expr.args[i] as Expression);
        }
        break;

      case "if":
        // Every branch, taken or not: a dependency is what the rule may read.
        if (expr.else !== undefined) {
          stack.push(expr.else);
        }
        for (let i = expr.cases.length - 1; i >= 0; i -= 1) {
          const entry = expr.cases[i] as { when: Expression; then: Expression };
          stack.push(entry.then, entry.when);
        }
        break;

      case "literal":
      default:
        break;
    }
  }

  return out;
}
