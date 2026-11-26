import type { FormulaFunctionContribution } from "../../core/schema/contracts.js";
import { FORMULA_FUNCTION_NAMES } from "../../core/expressions/function-table.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";

/** A plugin function as a row of the builder's function table (the shape of the built-in rows). */
export interface FormulaFunctionTableRow {
  name: string;
  params: readonly string[];
  variadic?: true;
  min?: number;
  returns: NonNullable<FormulaFunctionContribution["returns"]> | "any";
  summary: string;
  example: string;
  /** The plugin that contributed the function. */
  plugin: string;
  snippets?: Array<{ label: string; insert: string }>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that are not functions but object plumbing: assigned on the plain object
 * {@link FormulaFunctionRegistry.functions} returns, `__proto__` would set its prototype and
 * `constructor`/`prototype` would shadow what every consumer's own-property guard reads. A
 * plugin naming one is refused outright rather than registered and silently uncallable.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Plugin-contributed formula functions (a plugin's `formulaFunctions`), keyed by name. A name
 * that is a built-in or already taken is refused, so a formula means the same thing on every
 * host that has the plugin.
 */
export class FormulaFunctionRegistry {
  private readonly byName = new Map<string, { contribution: FormulaFunctionContribution; plugin: string }>();

  public register(contribution: FormulaFunctionContribution, pluginId: string): void {
    const name = contribution?.name;
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new Error(`Formula function from plugin "${pluginId}" needs a name of letters, digits and underscores`);
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Formula function "${name}" from plugin "${pluginId}" uses a reserved name and cannot be registered`);
    }
    if (typeof contribution.evaluate !== "function") {
      throw new Error(`Formula function "${name}" from plugin "${pluginId}" needs an evaluate function`);
    }
    if (!Array.isArray(contribution.params)) {
      throw new Error(`Formula function "${name}" from plugin "${pluginId}" needs a params list`);
    }
    if (FORMULA_FUNCTION_NAMES.has(name)) {
      throw new Error(`Formula function "${name}" from plugin "${pluginId}" is a built-in and cannot be replaced`);
    }
    const existing = this.byName.get(name);
    if (existing) {
      throw new Error(
        `Formula function "${name}" from plugin "${pluginId}" is already registered by plugin "${existing.plugin}"`
      );
    }
    this.byName.set(name, { contribution, plugin: pluginId });
  }

  /** The functions by name, for `RuleEvaluationContext.functions`. */
  public functions(): Record<string, (args: unknown[]) => unknown> {
    const result: Record<string, (args: unknown[]) => unknown> = {};
    for (const [name, { contribution }] of this.byName) {
      result[name] = contribution.evaluate;
    }
    return result;
  }

  /** Name and arity of each function, the shape the parser's arity check reads. */
  public signatures(): FormulaFunctionSignature[] {
    return [...this.byName.values()].map(({ contribution }) => {
      const required = contribution.params.filter((param) => !param.endsWith("?")).length;
      if (contribution.variadic) {
        return { name: contribution.name, min: contribution.min ?? 0, max: Infinity };
      }
      return { name: contribution.name, min: contribution.min ?? required, max: contribution.params.length };
    });
  }

  /** Rows for the builder's function table, in registration order. */
  public table(): FormulaFunctionTableRow[] {
    return [...this.byName.values()].map(({ contribution, plugin }) => {
      const row: FormulaFunctionTableRow = {
        name: contribution.name,
        params: [...contribution.params],
        returns: contribution.returns ?? "any",
        summary: contribution.summary,
        example: contribution.example,
        plugin
      };
      if (contribution.variadic) row.variadic = true;
      if (contribution.min !== undefined) row.min = contribution.min;
      if (contribution.snippets) row.snippets = contribution.snippets.map((snippet) => ({ ...snippet }));
      return row;
    });
  }
}
