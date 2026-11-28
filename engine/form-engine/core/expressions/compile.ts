/**
 * Compiling the formulas a definition carries. A component rule, a journey route condition, a
 * worked-out value and a PDF layout condition or field source is a FEEL-subset string, or the
 * object form `{ formula, run }`. Before anything reads a rule, a runtime compiles the
 * definition into a copy whose formulas are trees (a bare tree, or `{ expression, run }`) and
 * reads the copy. The author's object is never changed: hosts hash the stored JSON, and the
 * submissions validator hands the catalog's definition to the kernel as is. A tree is the
 * compiled copy's shape alone: an authored rule written as one is reported as `invalidRule`
 * and read as no rule. The PDF render compiles a copy it is handed again (`compiled`), where a
 * tree passes through.
 *
 * What compiles, and where a server scope may stand:
 * - A form component's `rules`: the eleven {@link ComponentRules} keys compile; any other key is
 *   copied as written (an annotation, a host's own key). `visibleWhen`, `requiredWhen`,
 *   `enabledWhen`, `readonlyWhen`, `validWhen`, `value` and a data grid's `minRows` / `maxRows`
 *   may run `server` or `server-secret`; the browser-only keys (`defaultValue`,
 *   `filter`, `navigationGating`) may not.
 * - A journey's own nodes (their `rules` and a journey-value's `value`), a journey route
 *   `when`, a PDF layout `when` and a PDF field or area expression source: the browser
 *   alone applies these, so `run` may only be `both` or `browser`.
 * A `run` a site may not take is reported as `runScope` and the rule runs on both sides. A rule
 * value that is neither a formula string nor the object form is reported as `invalidRule`:
 * under `rules` the key is dropped; at a `when`, `value` or source site a tree is dropped too,
 * and any other value stays as written so the shape validators refuse it.
 *
 * Kernel-shaped (see `validation/wasm/portable-kernel.ts`): top-level `kernel*` function
 * declarations that reference only each other and standard globals, no module constants, nothing
 * nondeterministic. {@link COMPILE_FUNCTIONS} lists them for the sandbox and PDF programs. The
 * parser is an argument: the kernel passes `kernelParseFormula`, a test passes a stub. Trees are
 * walked with an explicit stack, so a form or an own layout of any depth compiles.
 */
import type { Expression, FormulaErrorPolicy, RunScope } from "./expression.js";
import type { ComponentNode, FormDefinition } from "../schema/types.js";
import { normalizeDataGrids } from "../schema/data-grid.js";
import type { CompiledDefinition, FormulaFunctionSignature, FormulaParseResult, FormulaProblem } from "./formula-types.js";

/** The parser the compile functions take: `kernelParseFormula` in the kernel, a stub in a test. */
export type FormulaParser = (text: string, signatures: FormulaFunctionSignature[]) => FormulaParseResult;

/** The compiled form of a rule written as an object: the tree, and the scope when one was written. */
export interface CompiledRule {
  expression: Expression;
  run?: RunScope;
}

/** How a rule site is written; see {@link kernelRuleShape}. */
export type RuleShape = "absent" | "formula" | "tree" | "object" | "invalid";

/** What compiling one rule site yields; see {@link kernelCompileSite}. */
export interface CompiledSite {
  /** The tree, or `undefined` when the site holds no usable rule. */
  expression: Expression | undefined;
  /** The scope the object form wrote (a valid word), after the site's check; absent otherwise. */
  run: RunScope | undefined;
  /** The value was none of the three shapes (reported as `invalidRule`). */
  invalid: boolean;
}

/** A record that is not an array: what every shape here is read through. */
export function kernelIsPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An expression tree as the evaluator reads one: a record with a string `kind`. */
export function kernelIsExpressionTree(value: unknown): value is Expression {
  return kernelIsPlainRecord(value) && typeof value.kind === "string";
}

/**
 * What keeps the evaluator from reading a tree, or `undefined` when nothing does. The parser
 * builds every tree it returns to this shape; a tree reaches a reader as is only from a compiled
 * copy (a copy compiled again, a rule read from one), and the evaluator reads a node of the wrong
 * shape as a raw `TypeError` (an `and` with no right side) or as `undefined` (a call to a function
 * this side lacks), which silently hides a field the other side shows. Read as the builder's
 * `isExpression` reads one, save that a literal may hold any value (a choice's default ticks a
 * record or a list of options): a path holds a non-empty text; a `unary` is a `not` over a tree;
 * a comparison, `and`/`or` or arithmetic has an operator text and two trees; a call a name and a
 * list of trees; an `if` a list of `{ when, then }` trees and an optional `else` tree. The faults,
 * in this order of precedence:
 * - `invalidRule` for the first node, in reading order, of no such shape, which stops the walk;
 * - `unknownFunction`, only when the tree has none, for the first call naming no function in
 *   `signatures` (the side's own list, plugins included, exactly what its parser checks a
 *   formula against). With `signatures` absent the names are not looked at.
 * Walked with an explicit stack, so a chain of any length is read without recursion.
 */
export function kernelExpressionFault(
  tree: unknown,
  signatures: FormulaFunctionSignature[] | undefined
): { code: "invalidRule" | "unknownFunction"; message: string; params: Record<string, string | number> } | undefined {
  let unknown: string | undefined;
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    let fault: string | undefined;
    if (!kernelIsPlainRecord(node) || typeof node.kind !== "string") {
      fault = "a node that is not an expression";
    } else {
      const kind = node.kind;
      if (kind === "literal") {
        // Any value: the evaluator hands a literal back as written, and a choice's default is a
        // record or a list of the options it ticks.
      } else if (kind === "path") {
        if (typeof node.path !== "string" || node.path === "") {
          fault = "a path with no path text";
        }
      } else if (kind === "unary") {
        if (node.operator !== "not") {
          fault = "a unary node that is not a not";
        } else {
          stack.push(node.operand);
        }
      } else if (kind === "binary" || kind === "logical" || kind === "arithmetic") {
        if (typeof node.operator !== "string") {
          fault = "a " + kind + " node with no operator";
        } else {
          // Right first, so the left is read first.
          stack.push(node.right);
          stack.push(node.left);
        }
      } else if (kind === "call") {
        if (typeof node.name !== "string" || !Array.isArray(node.args)) {
          fault = "a call with no name or no list of arguments";
        } else {
          if (unknown === undefined && signatures !== undefined) {
            let known = false;
            for (let s = 0; s < signatures.length; s += 1) {
              const signature = signatures[s] as unknown;
              if (kernelIsPlainRecord(signature) && signature.name === node.name) {
                known = true;
                break;
              }
            }
            if (!known) {
              unknown = node.name;
            }
          }
          for (let a = node.args.length - 1; a >= 0; a -= 1) {
            stack.push(node.args[a]);
          }
        }
      } else if (kind === "if") {
        if (!Array.isArray(node.cases)) {
          fault = "an if with no list of cases";
        } else {
          if (node.else !== undefined) {
            stack.push(node.else);
          }
          for (let c = node.cases.length - 1; c >= 0 && fault === undefined; c -= 1) {
            const entry: unknown = node.cases[c];
            if (!kernelIsPlainRecord(entry)) {
              fault = "an if case that is not a when and a then";
            } else {
              stack.push(entry.then);
              stack.push(entry.when);
            }
          }
        }
      } else {
        fault = "a node of no kind the evaluator reads";
      }
    }
    if (fault !== undefined) {
      return { code: "invalidRule", message: "The expression tree holds " + fault + ".", params: { got: "malformed tree" } };
    }
  }
  if (unknown !== undefined) {
    return { code: "unknownFunction", message: 'Unknown function "' + unknown + '".', params: { name: unknown } };
  }
  return undefined;
}

/**
 * The rule's object form: a record with no `kind` that carries a `formula` string, or, in a
 * compiled copy, an `expression` tree. `{}`, `{ run: "server" }` and `{ kind: 5 }` are none of
 * the shapes.
 */
export function kernelIsRuleObject(value: unknown): value is Record<string, unknown> {
  return kernelIsPlainRecord(value) && value.kind === undefined && (typeof value.formula === "string" || kernelIsExpressionTree(value.expression));
}

/**
 * How a rule site is written: `absent` (undefined, or `null` as JSON writes a cleared rule), a
 * `formula` string, a `tree` (a compiled copy's shape, which an authored rule may not take), the
 * `object` form, or `invalid` for anything else (a boolean, a number, an array, an object that is
 * none of the shapes).
 */
export function kernelRuleShape(value: unknown): RuleShape {
  if (value === undefined || value === null) {
    return "absent";
  }
  if (typeof value === "string") {
    return "formula";
  }
  if (kernelIsExpressionTree(value)) {
    return "tree";
  }
  if (kernelIsRuleObject(value)) {
    return "object";
  }
  return "invalid";
}

/** Whether `value` is one of the four scope words. */
export function kernelIsRunScope(value: unknown): value is RunScope {
  return value === "both" || value === "browser" || value === "server" || value === "server-secret";
}

/** Whether `key` is a rule the browser alone applies: the server never sets defaults, filters options or gates steps. */
export function kernelIsBrowserOnlyRuleKey(key: string): boolean {
  return key === "defaultValue" || key === "filter" || key === "navigationGating";
}

/**
 * Whether `key` is one of the eight rules the kernel applies (`validWhen`, a data
 * grid's `minRows` and `maxRows`): the only sites a server scope may stand on.
 */
export function kernelIsServerRuleKey(key: string): boolean {
  return (
    key === "visibleWhen" ||
    key === "requiredWhen" ||
    key === "enabledWhen" ||
    key === "readonlyWhen" ||
    key === "validWhen" ||
    key === "value" ||
    key === "minRows" ||
    key === "maxRows"
  );
}

/** Whether `key` is one of the eleven `ComponentRules` keys the compile reads; any other key under `rules` is copied as written. */
export function kernelIsRuleKey(key: string): boolean {
  return kernelIsServerRuleKey(key) || kernelIsBrowserOnlyRuleKey(key);
}

/**
 * The tree a rule source stands for, or `undefined` when there is none: a string parses, the
 * object form parses its `formula`, and a compiled copy's tree (bare, or the object form's
 * `expression`) passes through when the evaluator can read its shape
 * ({@link kernelExpressionFault}). A failed parse reads as no rule, which is the evaluation-time
 * reading under every policy.
 */
export function kernelRuleExpression(
  source: unknown,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[]
): Expression | undefined {
  if (typeof source === "string") {
    const parsed = parse(source, signatures);
    return parsed.ok ? parsed.expression : undefined;
  }
  // A tree the evaluator cannot read (a node of no shape) reads as no rule, as a formula that
  // does not parse does; the names it calls are the compile's to judge.
  if (kernelIsExpressionTree(source)) {
    return kernelExpressionFault(source, undefined) === undefined ? source : undefined;
  }
  if (!kernelIsRuleObject(source)) {
    return undefined;
  }
  if (kernelIsExpressionTree(source.expression)) {
    return kernelExpressionFault(source.expression, undefined) === undefined ? source.expression : undefined;
  }
  if (typeof source.formula === "string") {
    const parsed = parse(source.formula, signatures);
    return parsed.ok ? parsed.expression : undefined;
  }
  return undefined;
}

/** Where a rule runs: what the object form says, else `"both"`; a word that is not a scope reads as `"both"`. */
export function kernelRuleRun(source: unknown): RunScope {
  if (kernelIsRuleObject(source) && kernelIsRunScope(source.run)) {
    return source.run;
  }
  return "both";
}

/**
 * Whether `side` applies the rule under `key`. The browser-only keys are the browser's whatever
 * their `run` says; every other key follows its scope: the browser runs `both` and `browser`, the
 * server runs `both`, `server` and `server-secret`.
 */
export function kernelRuleRunsOn(source: unknown, key: string, side: "browser" | "server"): boolean {
  if (kernelIsBrowserOnlyRuleKey(key)) {
    return side === "browser";
  }
  const run = kernelRuleRun(source);
  if (side === "browser") {
    return run === "both" || run === "browser";
  }
  return run === "both" || run === "server" || run === "server-secret";
}

/** The formula text a source carries, for a problem's `text`; a tree has none. */
export function kernelRuleText(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }
  if (kernelIsRuleObject(source) && typeof source.formula === "string") {
    return source.formula;
  }
  return "";
}

/**
 * Compiles one formula site to its tree, pushing a problem at `where` when the formula does not
 * parse. `undefined` means the site holds no rule: absent, blank, unparseable (reported) or of a
 * shape no reader accepts ({@link kernelCompileSite} reports that). A compiled copy's tree passes
 * through; {@link kernelCompileSite} lets one reach here only when it compiles such a copy again.
 */
export function kernelCompileSource(
  source: unknown,
  where: string,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[]
): Expression | undefined {
  let text: string | undefined;
  if (typeof source === "string") {
    text = source;
  } else if (kernelIsExpressionTree(source)) {
    return source;
  } else if (kernelIsRuleObject(source)) {
    if (kernelIsExpressionTree(source.expression)) {
      return source.expression;
    }
    if (typeof source.formula === "string") {
      text = source.formula;
    }
  }
  if (text === undefined) {
    return undefined;
  }
  const parsed = parse(text, signatures);
  if (parsed.ok) {
    return parsed.expression;
  }
  problems.push({
    where,
    code: parsed.code,
    message: typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : parsed.code,
    params: kernelIsPlainRecord(parsed.params) ? parsed.params : {},
    start: parsed.start,
    end: parsed.end,
    text
  });
  return undefined;
}

/** The JSON type of a value, for an `invalidRule` problem's `got`. */
export function kernelJsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * Compiles one rule site with its shape and scope checks. `key` names the rule for the problem
 * (`visibleWhen`, `when`, `value`, `expression`); `serverAllowed` says whether `server` and
 * `server-secret` may stand here (only a form component's eight kernel-applied rules). A value
 * that is neither a formula nor the object form is reported as `invalidRule`: a tree (bare, or
 * the object form's `expression`) comes back as no rule, as a formula that does not parse does;
 * anything else comes back `invalid`. With `recompile` the source is a compiled copy's, compiled
 * again (the PDF render's read of the copy it is handed), and a tree is read as the compiled rule
 * it is. A scope the site may not take is reported as `runScope` and comes back as `both`. `run`
 * is set only when the object form wrote a valid scope word, so the compiled object omits what
 * was not written.
 */
export function kernelCompileSite(
  source: unknown,
  where: string,
  key: string,
  serverAllowed: boolean,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): CompiledSite {
  const shape = kernelRuleShape(source);
  if (shape === "absent") {
    return { expression: undefined, run: undefined, invalid: false };
  }
  const tree = shape === "tree" || (shape === "object" && kernelIsPlainRecord(source) && kernelIsExpressionTree(source.expression));
  if (shape === "invalid" || (tree && recompile !== true)) {
    const got = tree ? "tree" : kernelJsonTypeOf(source);
    problems.push({
      where,
      code: "invalidRule",
      message: "A " + key + " rule is a formula or an object with a formula; this one is " + (tree ? "an expression tree" : got),
      params: { key, got }
    });
    return { expression: undefined, run: undefined, invalid: !tree };
  }
  let expression = kernelCompileSource(source, where, parse, signatures, problems);
  // A compiled copy's tree, compiled again, goes through the guards a formula's parse applies on
  // this side: its shape and the functions it calls, against this side's own list (a PDF's may
  // lack a function the runtime that compiled the copy knows). A tree that fails is dropped as a
  // formula that does not parse is. A tree has no text, so the problem carries none.
  if (expression !== undefined && tree) {
    const fault = kernelExpressionFault(expression, signatures);
    if (fault !== undefined) {
      const params = fault.params;
      if (fault.code === "invalidRule") {
        params.key = key;
      }
      problems.push({ where, code: fault.code, message: fault.message, params, start: 0, end: 0 });
      expression = undefined;
    }
  }
  let run: RunScope | undefined;
  if (shape === "object" && kernelIsPlainRecord(source) && kernelIsRunScope(source.run)) {
    run = source.run;
  }
  if (run !== undefined && run !== "both" && run !== "browser" && !serverAllowed) {
    const text = kernelRuleText(source);
    problems.push({
      where,
      code: "runScope",
      message: kernelIsBrowserOnlyRuleKey(key)
        ? "A " + key + " rule runs in the browser only; run cannot be " + run
        : "Only a form component's visibleWhen, requiredWhen, enabledWhen, readonlyWhen, validWhen and value rules may run on the server; a " + key + " rule here cannot run " + run,
      params: { key, run },
      start: 0,
      end: text.length,
      text
    });
    run = "both";
  }
  return { expression, run, invalid: false };
}

/**
 * Compiles a `rules` record into a new one: a string becomes its tree, the object form becomes
 * `{ expression, run? }` with the formula dropped (with `recompile`, a compiled copy's tree passes
 * through). Only the eleven `ComponentRules` keys compile; any other key is copied as written. A
 * key whose formula fails to parse, or whose value is none of the shapes, is left out and
 * reported at `<where>:<key>`. A
 * scope the key may not take (`serverAllowed` false, or a browser-only key) is reported as
 * `runScope` and the key kept as running on both sides.
 */
export function kernelCompileRules(
  rules: unknown,
  where: string,
  serverAllowed: boolean,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): Record<string, unknown> {
  const compiled: Record<string, unknown> = {};
  if (!kernelIsPlainRecord(rules)) {
    return compiled;
  }
  for (const key of Object.keys(rules)) {
    const source = rules[key];
    if (!kernelIsRuleKey(key)) {
      compiled[key] = source;
      continue;
    }
    const reported = problems.length;
    const site = kernelCompileSite(source, where + ":" + key, key, serverAllowed && kernelIsServerRuleKey(key), parse, signatures, problems, recompile);
    if (site.expression === undefined) {
      // A check that cannot be read refuses rather than vanishes: a
      // `validWhen` the compile reported (a formula that does not parse, a value of none of the
      // shapes) never holds. Under `fail` the problem refuses the whole definition first; under
      // `warn` this is what still stands. A blank formula is no rule, as for every key.
      if (key === "validWhen" && problems.length > reported) {
        const never: CompiledRule = { expression: { kind: "literal", value: false } };
        if (site.run !== undefined) {
          never.run = site.run;
        }
        compiled[key] = never;
      }
      continue;
    }
    if (kernelRuleShape(source) !== "object") {
      compiled[key] = site.expression;
      continue;
    }
    const rule: CompiledRule = { expression: site.expression };
    if (site.run !== undefined) {
      rule.run = site.run;
    }
    compiled[key] = rule;
  }
  return compiled;
}

/**
 * A copy of the tree under `root` with `rewrite(node)` applied to every record node, parents
 * before children in document order, walked with an explicit stack so a tree of any depth copies
 * without recursion. `rewrite` returns the node's shallow copy; its `children` record is rebuilt
 * here (a slot that is not an array becomes `[]`; a `children` that is not a record stays as the
 * copy carries it). A node that is not a record is copied as written and not descended.
 */
export function kernelCopyTree(root: unknown, rewrite: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  const holder: unknown[] = [undefined];
  const fixups: Array<{ into: Record<string, unknown>; slot: string; box: unknown[] }> = [];
  const stack: Array<{ node: unknown; into: unknown[]; at: number }> = [{ node: root, into: holder, at: 0 }];
  while (stack.length > 0) {
    const item = stack.pop() as { node: unknown; into: unknown[]; at: number };
    if (!kernelIsPlainRecord(item.node)) {
      item.into[item.at] = item.node;
      continue;
    }
    const copy = rewrite(item.node);
    item.into[item.at] = copy;
    if (!kernelIsPlainRecord(item.node.children)) {
      continue;
    }
    const children: Record<string, unknown> = {};
    const pending: Array<{ node: unknown; into: unknown[]; at: number }> = [];
    for (const slot of Object.keys(item.node.children)) {
      const list = item.node.children[slot];
      // A slot that is not a list is kept as written for the shape checks to refuse, as before;
      // a record there is walked as a node all the same, so a rewrite that removes
      // something (the public copy's secret rules) reaches it too. It lands in `box` when popped.
      if (!Array.isArray(list)) {
        if (kernelIsPlainRecord(list)) {
          const box: unknown[] = [undefined];
          pending.push({ node: list, into: box, at: 0 });
          fixups.push({ into: children, slot, box });
        } else {
          Object.defineProperty(children, slot, { value: list, enumerable: true, writable: true, configurable: true });
        }
        continue;
      }
      const copies: unknown[] = [];
      for (let index = 0; index < list.length; index += 1) {
        copies.push(undefined);
        pending.push({ node: list[index], into: copies, at: index });
      }
      Object.defineProperty(children, slot, { value: copies, enumerable: true, writable: true, configurable: true });
    }
    copy.children = children;
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      stack.push(pending[p] as { node: unknown; into: unknown[]; at: number });
    }
  }
  for (let f = 0; f < fixups.length; f += 1) {
    const fixup = fixups[f] as { into: Record<string, unknown>; slot: string; box: unknown[] };
    Object.defineProperty(fixup.into, fixup.slot, { value: fixup.box[0], enumerable: true, writable: true, configurable: true });
  }
  return holder[0];
}

/** A new node with compiled rules and copied children; configuration and collection are shared. */
export function kernelCompileNode(
  node: ComponentNode,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): ComponentNode {
  return kernelCopyTree(node, function (one: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...one };
    if (one.rules !== undefined) {
      copy.rules = kernelCompileRulesOf(one.rules, "rules:" + (typeof one.id === "string" ? one.id : ""), true, parse, signatures, problems, recompile);
    }
    return copy;
  }) as ComponentNode;
}

/**
 * Copies a page entry: a string as is, an own node with its value and rules compiled, a reference
 * as is. Own nodes run in the browser alone, so no rule of theirs may take a server scope.
 */
export function kernelCompileJourneyEntry(
  entry: unknown,
  where: string,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): unknown {
  return kernelCopyTree(entry, function (one: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...one };
    const nodeWhere = where + ":node:" + (typeof one.id === "string" ? one.id : "");
    if (one.type === "journey-value" && kernelIsPlainRecord(one.configuration)) {
      const configuration: Record<string, unknown> = { ...one.configuration };
      const site = kernelCompileSite(one.configuration.value, nodeWhere, "value", false, parse, signatures, problems, recompile);
      if (site.expression !== undefined) {
        configuration.value = site.expression;
      } else if (!site.invalid) {
        delete configuration.value;
      }
      copy.configuration = configuration;
    }
    if (one.rules !== undefined) {
      copy.rules = kernelCompileRulesOf(one.rules, nodeWhere, false, parse, signatures, problems, recompile);
    }
    return copy;
  });
}

/**
 * A node's `rules` compiled, or kept as written when it is not a record (a list, a string, null):
 * the shape checks downstream refuse it as they did before formulas, on both sides, and the
 * problem names it. Compiling it to `{}` would make a malformed node pass where it used to fail.
 */
export function kernelCompileRulesOf(
  rules: unknown,
  where: string,
  serverAllowed: boolean,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): unknown {
  if (kernelIsPlainRecord(rules)) {
    return kernelCompileRules(rules, where, serverAllowed, parse, signatures, problems, recompile);
  }
  if (rules === null) {
    // A null rules block is no rules, as the 2.5 program read it; nothing to say.
    return rules;
  }
  problems.push({
    where,
    code: "invalidRule",
    message: "A component's rules are an object keyed by rule name; this one is " + kernelJsonTypeOf(rules),
    params: { key: "rules", got: kernelJsonTypeOf(rules) }
  });
  return rules;
}

/**
 * Compiles a `when` (or a PDF source's `expression`) in place on `copy[key]`: the tree when the
 * site holds one, the key removed when it holds none, the value kept as written when it is of no
 * shape (reported, and left for the shape validators to refuse). A `run` other than `both` or
 * `browser` is reported; the compiled site is the bare tree either way.
 */
export function kernelCompileWhen(
  copy: Record<string, unknown>,
  key: string,
  where: string,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): void {
  const site = kernelCompileSite(copy[key], where, key, false, parse, signatures, problems, recompile);
  if (site.expression !== undefined) {
    copy[key] = site.expression;
  } else if (!site.invalid) {
    delete copy[key];
  }
}

/** A compiled copy of a journey configuration; anything that is not the expected shape passes through as is. */
export function kernelCompileJourney(
  journey: unknown,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  recompile?: boolean
): unknown {
  if (!kernelIsPlainRecord(journey) || !Array.isArray(journey.journeys)) {
    return journey;
  }
  const journeys: unknown[] = [];
  for (let j = 0; j < journey.journeys.length; j += 1) {
    const one = journey.journeys[j];
    if (!kernelIsPlainRecord(one) || !Array.isArray(one.pages)) {
      journeys.push(one);
      continue;
    }
    const journeyId = typeof one.id === "string" ? one.id : "";
    const pages: unknown[] = [];
    for (let p = 0; p < one.pages.length; p += 1) {
      const page = one.pages[p];
      if (!kernelIsPlainRecord(page)) {
        pages.push(page);
        continue;
      }
      const pageWhere = "journey:" + journeyId + ":page:" + (typeof page.id === "string" ? page.id : "");
      const pageCopy: Record<string, unknown> = { ...page };
      if (Array.isArray(page.components)) {
        const entries: unknown[] = [];
        for (let e = 0; e < page.components.length; e += 1) {
          entries.push(kernelCompileJourneyEntry(page.components[e], "journey:" + journeyId, parse, signatures, problems, recompile));
        }
        pageCopy.components = entries;
      }
      if (Array.isArray(page.routes)) {
        const routes: unknown[] = [];
        for (let r = 0; r < page.routes.length; r += 1) {
          const route = page.routes[r];
          if (!kernelIsPlainRecord(route) || route.when === undefined) {
            routes.push(route);
            continue;
          }
          const routeCopy: Record<string, unknown> = { ...route };
          kernelCompileWhen(routeCopy, "when", pageWhere + ":route:" + r, parse, signatures, problems, recompile);
          routes.push(routeCopy);
        }
        pageCopy.routes = routes;
      }
      pages.push(pageCopy);
    }
    journeys.push({ ...one, pages });
  }
  return { ...journey, journeys };
}

/**
 * Whether a rule that reaches the compile as a tree (a bare tree, or the object form with an
 * `expression`: a compiled copy compiled again, or a block of a layout's own tree) holds a
 * `matches` call with a literal pattern of a catastrophic shape: the parse guard
 * ({@link kernelRiskGuardParser}) only sees formula text. When it does, the problem
 * `pattern.risky` is pushed at `where` and the answer is `true` (the caller drops the site, as it
 * does one the parser rejects). Nothing is looked at under `riskyPatterns: "allow"`.
 */
export function kernelRiskyTreeSite(written: unknown, compiled: unknown, where: string, riskyPatterns: unknown, problems: FormulaProblem[]): boolean {
  if (riskyPatterns === "allow" || !(kernelIsExpressionTree(written) || (kernelIsRuleObject(written) && kernelIsExpressionTree(written.expression)))) {
    return false;
  }
  if (!kernelIsExpressionTree(compiled)) {
    return false;
  }
  const pattern = kernelRiskyMatchesIn(compiled);
  if (pattern === undefined) {
    return false;
  }
  problems.push({ where, code: "pattern.risky", message: kernelRiskyPatternMessage(pattern), params: { pattern }, start: 0, end: 0 });
  return true;
}

/** Copies a field mapping or an area, compiling an expression source; any other source shares the binding. */
export function kernelCompilePdfBinding(
  binding: unknown,
  where: string,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  riskyPatterns?: unknown,
  recompile?: boolean
): unknown {
  if (!kernelIsPlainRecord(binding) || !kernelIsPlainRecord(binding.source) || binding.source.kind !== "expression") {
    return binding;
  }
  const source: Record<string, unknown> = { ...binding.source };
  kernelCompileWhen(source, "expression", where, parse, signatures, problems, recompile);
  if (kernelRiskyTreeSite(binding.source.expression, source.expression, where, riskyPatterns, problems)) {
    delete source.expression;
  }
  return { ...binding, source };
}

/**
 * The expression sites inside a generated layout's tree that the render reads (a text block's
 * `configuration.expression`) or may carry (a block's `rules`), looked at for a risky literal
 * pattern: formula text is parsed by the guard, a tree by {@link kernelRiskyTreeSite}. Only
 * `pattern.risky` is reported; any other rule of a block is left alone. Explicit stack. The
 * evaluator refuses such a pattern at the call anyway, so a site left in the copy runs safely.
 */
export function kernelPdfRiskyNodes(
  root: unknown,
  where: string,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  riskyPatterns: unknown,
  problems: FormulaProblem[]
): void {
  if (riskyPatterns === "allow") {
    return;
  }
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!kernelIsPlainRecord(node)) {
      continue;
    }
    const at = where + ":node:" + (typeof node.id === "string" ? node.id : "");
    if (kernelIsPlainRecord(node.configuration)) {
      kernelRiskyTreeSite(node.configuration.expression, node.configuration.expression, at + ":expression", riskyPatterns, problems);
    }
    if (kernelIsPlainRecord(node.rules)) {
      const keys = Object.keys(node.rules);
      for (let k = 0; k < keys.length; k += 1) {
        const written = node.rules[keys[k] as string];
        const rule = kernelIsRuleObject(written) && typeof written.formula === "string" && !kernelIsExpressionTree(written.expression) ? written.formula : written;
        if (typeof rule === "string") {
          const parsed = parse(rule, signatures);
          if (!parsed.ok && parsed.code === "pattern.risky") {
            problems.push({ where: at + ":rules:" + keys[k], code: "pattern.risky", message: parsed.message, params: kernelIsPlainRecord(parsed.params) ? parsed.params : {}, start: parsed.start, end: parsed.end, text: rule });
          }
        } else {
          kernelRiskyTreeSite(written, kernelIsRuleObject(written) ? written.expression : written, at + ":rules:" + keys[k], riskyPatterns, problems);
        }
      }
    }
    if (kernelIsPlainRecord(node.children)) {
      const slots = Object.keys(node.children);
      for (let k = 0; k < slots.length; k += 1) {
        const list = node.children[slots[k] as string];
        if (Array.isArray(list)) {
          for (let c = 0; c < list.length; c += 1) {
            stack.push(list[c]);
          }
        }
      }
    }
  }
}

/** A compiled copy of a PDF configuration; anything that is not the expected shape passes through as is. */
export function kernelCompilePdf(
  pdf: unknown,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  problems: FormulaProblem[],
  riskyPatterns?: unknown,
  recompile?: boolean
): unknown {
  if (!kernelIsPlainRecord(pdf) || !Array.isArray(pdf.layouts)) {
    return pdf;
  }
  const layouts: unknown[] = [];
  for (let l = 0; l < pdf.layouts.length; l += 1) {
    const layout = pdf.layouts[l];
    if (!kernelIsPlainRecord(layout)) {
      layouts.push(layout);
      continue;
    }
    const layoutWhere = "pdf:" + (typeof layout.id === "string" ? layout.id : "");
    const copy: Record<string, unknown> = { ...layout };
    if (layout.when !== undefined) {
      kernelCompileWhen(copy, "when", layoutWhere, parse, signatures, problems, recompile);
      if (kernelRiskyTreeSite(layout.when, copy.when, layoutWhere, riskyPatterns, problems)) {
        delete copy.when;
      }
    }
    kernelPdfRiskyNodes(layout.root, layoutWhere, parse, signatures, riskyPatterns, problems);
    if (Array.isArray(layout.fields)) {
      const fields: unknown[] = [];
      for (let f = 0; f < layout.fields.length; f += 1) {
        fields.push(kernelCompilePdfBinding(layout.fields[f], layoutWhere + ":field:" + f, parse, signatures, problems, riskyPatterns, recompile));
      }
      copy.fields = fields;
    }
    if (Array.isArray(layout.areas)) {
      const areas: unknown[] = [];
      for (let a = 0; a < layout.areas.length; a += 1) {
        areas.push(kernelCompilePdfBinding(layout.areas[a], layoutWhere + ":area:" + a, parse, signatures, problems, riskyPatterns, recompile));
      }
      copy.areas = areas;
    }
    layouts.push(copy);
  }
  return { ...pdf, layouts };
}

/**
 * A compiled copy of a definition's three rule-bearing parts, with every formula site compiled
 * and the problems in document order: the form tree, then the journeys, then the PDF layouts.
 * The inputs are never changed; the copy shares configuration objects.
 * `riskyPatterns` (`"refuse"`, the default, or `"allow"`) says what a literal `matches` pattern
 * with a catastrophic shape does: refused as `pattern.risky`, like a formula that does not parse.
 * `recompile` says the parts are a compiled copy (the PDF render compiling the copy a runtime or
 * the program hands it): its trees pass through. Without it a rule written as a tree is
 * `invalidRule`.
 */
export function kernelCompileDefinition(
  root: ComponentNode,
  journey: unknown,
  pdf: unknown,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  riskyPatterns?: unknown,
  recompile?: boolean
): CompiledDefinition<{ root: ComponentNode; journey: unknown; pdf: unknown }> {
  const problems: FormulaProblem[] = [];
  // A literal risky `matches` pattern is refused unless the host allows it (`riskyPatterns`).
  parse = kernelRiskGuardParser(parse, riskyPatterns);
  const compiledRoot = kernelCompileNode(root, parse, signatures, problems, recompile);
  const compiledJourney = kernelCompileJourney(journey, parse, signatures, problems, recompile);
  const compiledPdf = kernelCompilePdf(pdf, parse, signatures, problems, riskyPatterns, recompile);
  return {
    definition: { root: compiledRoot, journey: compiledJourney, pdf: compiledPdf },
    problems,
    warnings: kernelConditionWarnings(compiledRoot, compiledJourney, compiledPdf)
  };
}

/**
 * What a call to the built-in `name` yields, for {@link kernelConditionKind}: `"boolean"` for
 * the functions the function table (`core/expressions/function-table.ts`) gives `returns:
 * "boolean"`, `"other"` for the ones it gives a number, text, list or day, `"unknown"` for the
 * ones that return `any` (`coalesce`, `first`, `last`) and for a name the table lacks (a plugin
 * function). Kernel code cannot import the table, so the names are listed here; a test keeps the
 * two in step.
 */
export function kernelCallResultKind(name: string): "boolean" | "other" | "unknown" {
  switch (name) {
    case "empty":
    case "isNumber":
    case "isDate":
    case "startsWith":
    case "endsWith":
    case "contains":
    case "matches":
    case "any":
    case "all":
    case "isWeekend":
      return "boolean";
    case "concat":
    case "upper":
    case "lower":
    case "titleCase":
    case "trim":
    case "substring":
    case "replace":
    case "join":
    case "text":
    case "padStart":
    case "len":
    case "indexOf":
    case "sum":
    case "min":
    case "max":
    case "avg":
    case "count":
    case "abs":
    case "round":
    case "roundTo":
    case "roundUp":
    case "roundDown":
    case "floor":
    case "ceil":
    case "modulo":
    case "power":
    case "sqrt":
    case "clamp":
    case "number":
    case "dateDiff":
    case "year":
    case "month":
    case "day":
    case "dayOfWeek":
    case "age":
    case "rowIndex":
    case "rowCount":
    case "split":
    case "selected":
    case "distinct":
    case "sort":
    case "reverse":
    case "append":
    case "pluck":
    case "today":
    case "date":
    case "dateAdd":
    case "startOfMonth":
    case "endOfMonth":
      return "other";
    default:
      return "unknown";
  }
}

/**
 * Whether a condition's result is a yes-or-no, as far as the tree alone shows (a condition holds
 * only for the boolean `true`). `"boolean"`: a comparison, `and`, `or`, `not`, the
 * literal `true` or `false`, a call to a function that returns a boolean, an `if` whose every
 * branch is one (a missing `else` is no answer, which a condition reads as not holding).
 * `"other"`: provably never a boolean, so the condition never holds: a number, text or `null`
 * literal, arithmetic, a call returning a number, text, list or day, an `if` with such a branch.
 * `"unknown"`: a bare field (a yes-or-no checkbox is fine, a text box is not, and the tree does
 * not know), `coalesce`, `first`, `last`, a plugin function. Explicit stack: a long `if` ladder
 * or a tree of any depth is no recursion.
 */
export function kernelConditionKind(expression: unknown): "boolean" | "other" | "unknown" {
  let unknown = false;
  const stack: unknown[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!kernelIsPlainRecord(node)) {
      unknown = true;
      continue;
    }
    switch (node.kind) {
      case "binary":
      case "logical":
      case "unary":
        break;
      case "literal":
        if (typeof node.value !== "boolean") {
          return "other";
        }
        break;
      case "arithmetic":
        return "other";
      case "call": {
        const kind = kernelCallResultKind(typeof node.name === "string" ? node.name : "");
        if (kind === "other") {
          return "other";
        }
        if (kind === "unknown") {
          unknown = true;
        }
        break;
      }
      case "if": {
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        if (Array.isArray(node.cases)) {
          for (let c = 0; c < node.cases.length; c += 1) {
            const entry = node.cases[c];
            stack.push(kernelIsPlainRecord(entry) ? entry.then : undefined);
          }
        }
        break;
      }
      default:
        unknown = true;
        break;
    }
  }
  return unknown ? "unknown" : "boolean";
}

/** The tree a compiled rule site holds: a tree as is, the object form's `expression`, else `undefined`. */
export function kernelCompiledTreeOf(source: unknown): unknown {
  if (kernelIsExpressionTree(source)) {
    return source;
  }
  return kernelIsPlainRecord(source) && kernelIsExpressionTree(source.expression) ? source.expression : undefined;
}

/**
 * Whether a compiled tree reads anything only a row has, anywhere (every branch of an `if`, both
 * sides of an operator, every argument of a call), walked with an explicit stack: a `row` or
 * `row.` path, an `ancestor` or `ancestor.` path, or a call of `rowIndex()` or `rowCount()`. A
 * data grid's bound (`rules.minRows` / `rules.maxRows`) belongs to the whole grid,
 * evaluated form-scoped where none of these has a value, so a bound that reads one is warned
 * about (`rule.unsupportedScope`) and never evaluated, on either side. A literal is not
 * descended: a value is not a read.
 */
export function kernelTreeReadsRow(tree: unknown): boolean {
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        stack.push(node[i]);
      }
      continue;
    }
    if (!kernelIsPlainRecord(node) || node.kind === "literal") {
      continue;
    }
    if (node.kind === "path" && typeof node.path === "string") {
      if (node.path === "row" || node.path.indexOf("row.") === 0 || node.path === "ancestor" || node.path.indexOf("ancestor.") === 0) {
        return true;
      }
      continue;
    }
    if (node.kind === "call" && (node.name === "rowIndex" || node.name === "rowCount")) {
      return true;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value !== null && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return false;
}

/** The warning for one compiled condition site when it is provably not a yes-or-no; pushes nothing otherwise. */
export function kernelPushConditionWarning(source: unknown, where: string, key: string, warnings: FormulaProblem[]): void {
  const tree = kernelCompiledTreeOf(source);
  if (tree === undefined || kernelConditionKind(tree) !== "other") {
    return;
  }
  warnings.push({
    where,
    code: "condition.notBoolean",
    severity: "warning",
    message: "A " + key + " condition has to come to yes or no; this one comes to something else, so it never holds",
    params: { key }
  });
}

/**
 * The condition warnings (`condition.notBoolean`, severity `warning`) of a compiled definition,
 * in document order: a component's `visibleWhen`, `requiredWhen`, `enabledWhen`, `readonlyWhen`,
 * `validWhen` and `navigationGating` (`rules:<id>:<key>`), a journey's own nodes the same way, a journey
 * route `when` and a PDF layout `when`, each whose result is provably not a yes-or-no
 * ({@link kernelConditionKind}). A warning never refuses a run, whatever `formulaErrors` says: the
 * condition simply never holds. Reads the compiled copy.
 */
export function kernelConditionWarnings(root: unknown, journey: unknown, pdf: unknown): FormulaProblem[] {
  const warnings: FormulaProblem[] = [];
  const onRules = function (rules: unknown, where: string): void {
    if (!kernelIsPlainRecord(rules)) {
      return;
    }
    kernelPushConditionWarning(rules.visibleWhen, where + ":visibleWhen", "visibleWhen", warnings);
    kernelPushConditionWarning(rules.requiredWhen, where + ":requiredWhen", "requiredWhen", warnings);
    kernelPushConditionWarning(rules.enabledWhen, where + ":enabledWhen", "enabledWhen", warnings);
    kernelPushConditionWarning(rules.readonlyWhen, where + ":readonlyWhen", "readonlyWhen", warnings);
    kernelPushConditionWarning(rules.validWhen, where + ":validWhen", "validWhen", warnings);
    kernelPushConditionWarning(rules.navigationGating, where + ":navigationGating", "navigationGating", warnings);
  };
  // Document order, parents before children: the stack takes a node's children reversed.
  const walk = function (start: unknown, whereOf: (node: Record<string, unknown>) => string): void {
    const stack: unknown[] = [start];
    // Parallel to `stack`: whether the node sits inside a repeating section's entry.
    const inSection: boolean[] = [false];
    while (stack.length > 0) {
      const node = stack.pop();
      const within = inSection.pop() === true;
      if (!kernelIsPlainRecord(node)) {
        continue;
      }
      onRules(node.rules, whereOf(node));
      if (within && kernelIsPlainRecord(node.rules) && node.rules.validWhen !== undefined) {
        // Neither side runs a validWhen on a field of a section's entry (documented): say so, so
        // the author does not rely on it.
        warnings.push({
          where: whereOf(node) + ":validWhen",
          code: "rule.unsupportedScope",
          severity: "warning",
          message: "A validWhen on a field inside a repeating section is not checked; use a plugin validator for per-entry checks",
          params: { key: "validWhen" }
        });
      }
      // A data grid's bound is the whole grid's: one that reads a row is never
      // evaluated, on either side, so the fixed bound stands; say so.
      if (kernelIsPlainRecord(node.rules)) {
        const bounds = ["minRows", "maxRows"];
        for (let b = 0; b < bounds.length; b += 1) {
          const key = bounds[b] as string;
          const tree = kernelCompiledTreeOf(node.rules[key]);
          if (tree !== undefined && kernelTreeReadsRow(tree)) {
            warnings.push({
              where: whereOf(node) + ":" + key,
              code: "rule.unsupportedScope",
              severity: "warning",
              message: "A " + key + " formula belongs to the whole data grid and cannot read row., ancestor., rowIndex() or rowCount(); it is not evaluated, so the fixed bound stands",
              params: { key }
            });
          }
        }
      }
      if (!kernelIsPlainRecord(node.children)) {
        continue;
      }
      const below = within || node.collection !== undefined;
      const slots = Object.keys(node.children);
      for (let s = slots.length - 1; s >= 0; s -= 1) {
        const list = node.children[slots[s] as string];
        if (Array.isArray(list)) {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            stack.push(list[i]);
            inSection.push(below);
          }
        }
      }
    }
  };
  walk(root, function (node) {
    return "rules:" + (typeof node.id === "string" ? node.id : "");
  });
  if (kernelIsPlainRecord(journey) && Array.isArray(journey.journeys)) {
    for (let j = 0; j < journey.journeys.length; j += 1) {
      const one = journey.journeys[j];
      if (!kernelIsPlainRecord(one) || !Array.isArray(one.pages)) {
        continue;
      }
      const journeyId = typeof one.id === "string" ? one.id : "";
      for (let p = 0; p < one.pages.length; p += 1) {
        const page = one.pages[p];
        if (!kernelIsPlainRecord(page)) {
          continue;
        }
        const pageWhere = "journey:" + journeyId + ":page:" + (typeof page.id === "string" ? page.id : "");
        if (Array.isArray(page.components)) {
          for (let e = 0; e < page.components.length; e += 1) {
            walk(page.components[e], function (node) {
              return "journey:" + journeyId + ":node:" + (typeof node.id === "string" ? node.id : "");
            });
          }
        }
        if (Array.isArray(page.routes)) {
          for (let r = 0; r < page.routes.length; r += 1) {
            const route = page.routes[r];
            if (kernelIsPlainRecord(route)) {
              kernelPushConditionWarning(route.when, pageWhere + ":route:" + r, "when", warnings);
            }
          }
        }
      }
    }
  }
  if (kernelIsPlainRecord(pdf) && Array.isArray(pdf.layouts)) {
    for (let l = 0; l < pdf.layouts.length; l += 1) {
      const layout = pdf.layouts[l];
      if (kernelIsPlainRecord(layout)) {
        kernelPushConditionWarning(layout.when, "pdf:" + (typeof layout.id === "string" ? layout.id : ""), "when", warnings);
      }
    }
  }
  return warnings;
}

/**
 * The deepest a definition may nest components, counting the root as level 1: a component at
 * level 33 is refused. The same count as a server host's
 * `DefinitionInspector::MAX_COMPONENT_DEPTH`. A function, not a constant: spliced source has no
 * module constants.
 */
export function kernelMaxComponentDepth(): number {
  return 32;
}

/**
 * What makes the form's component tree one no run can walk, or `undefined`; read after the depth
 * ({@link kernelComponentTooDeep}), so the walk is bounded. `check` describes each of these as a
 * structure problem; a run that was not given that verdict meets them here, before anything else
 * walks the tree, and refuses with a typed error instead of a raw `TypeError` or a walk that never
 * ends:
 * - `definition.malformed`: a `children` that is not a record of slots, a slot that is not a
 *   list, or an entry of a slot that is not a component record (`null`, a number);
 * - `definition.idCycle`: a component whose id is already on its own ancestor chain (a child
 *   sharing its parent's, a grandparent's or the form's id), which a walk from that node up
 *   through the ids' parents would follow forever. It names the nearest ancestor holding the
 *   id. Repeated ids off one chain (siblings, cousins, cousins crossing ids) are not this
 *   function's to judge: they are drawn with a notice and share one value, and the run's index
 *   never records a parent that would close a loop between them.
 * `where` reads `root > slot > id` like the depth's location.
 */
export function kernelComponentTreeFault(root: unknown): { code: string; where: string } | undefined {
  if (!kernelIsPlainRecord(root)) {
    return undefined;
  }
  // Each frame carries its ancestors as a linked chain of ids (at most the depth cap long).
  type KernelChainLink = { id: string; where: string; up: KernelChainLink | undefined };
  const stack: Array<{ node: Record<string, unknown>; where: string; up: KernelChainLink | undefined }> = [{ node: root, where: "root", up: undefined }];
  while (stack.length > 0) {
    const top = stack.pop() as { node: Record<string, unknown>; where: string; up: KernelChainLink | undefined };
    const id = top.node.id;
    let chain = top.up;
    if (typeof id === "string") {
      for (let at = top.up; at !== undefined; at = at.up) {
        if (at.id === id) {
          return { code: "definition.idCycle", where: at.where };
        }
      }
      chain = { id, where: top.where, up: top.up };
    }
    const children = top.node.children;
    if (children === undefined || children === null) {
      continue;
    }
    if (!kernelIsPlainRecord(children)) {
      return { code: "definition.malformed", where: top.where };
    }
    const pending: Array<{ node: Record<string, unknown>; where: string; up: KernelChainLink | undefined }> = [];
    const slots = Object.keys(children);
    for (let k = 0; k < slots.length; k += 1) {
      const list = children[slots[k] as string];
      if (!Array.isArray(list)) {
        return { code: "definition.malformed", where: top.where + " > " + slots[k] };
      }
      for (let i = 0; i < list.length; i += 1) {
        const child: unknown = list[i];
        if (!kernelIsPlainRecord(child)) {
          return { code: "definition.malformed", where: top.where + " > " + slots[k] + " > #" + i };
        }
        pending.push({ node: child, where: top.where + " > " + slots[k] + " > " + (typeof child.id === "string" ? child.id : "#" + i), up: chain });
      }
    }
    // Document order: the first child is walked first, as the run's index walks it.
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      stack.push(pending[p] as { node: Record<string, unknown>; where: string; up: KernelChainLink | undefined });
    }
  }
  return undefined;
}

/**
 * Where a definition nests components deeper than {@link kernelMaxComponentDepth}, or `undefined`.
 * The form's tree and each object entry a journey page lists (the nodes a presentation owns)
 * are measured apart, each from level 1, and the location reads `root > slot > id`
 * like a server host's. An explicit stack and no recursion: the guest's own stack is what a
 * deep definition would otherwise exhaust (the qjs-wasi build traps at about 80 levels), so this
 * pass runs before anything walks the tree.
 */
export function kernelComponentTooDeep(root: unknown, journey: unknown): string | undefined {
  const limit = kernelMaxComponentDepth();
  const starts: Array<{ node: unknown; where: string }> = [];
  if (root !== null && typeof root === "object") {
    starts.push({ node: root, where: "root" });
  }
  // A host passes a single journey `{ id, pages }` (the shape a run takes), the definition's
  // wrapper `{ journeys: [...] }` or the list of journeys itself; all three are measured.
  let journeys: unknown = undefined;
  if (Array.isArray(journey)) {
    journeys = journey;
  } else if (journey !== null && typeof journey === "object") {
    journeys = Array.isArray((journey as { journeys?: unknown }).journeys) ? (journey as { journeys?: unknown }).journeys : [journey];
  }
  if (Array.isArray(journeys)) {
    for (let j = 0; j < journeys.length; j += 1) {
      const one = journeys[j] as { pages?: unknown } | null;
      const pages = one !== null && typeof one === "object" ? one.pages : undefined;
      if (!Array.isArray(pages)) {
        continue;
      }
      for (let p = 0; p < pages.length; p += 1) {
        const page = pages[p] as { components?: unknown } | null;
        const entries = page !== null && typeof page === "object" ? page.components : undefined;
        if (!Array.isArray(entries)) {
          continue;
        }
        for (let e = 0; e < entries.length; e += 1) {
          const entry = entries[e] as { id?: unknown } | null;
          if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
            starts.push({ node: entry, where: typeof entry.id === "string" ? entry.id : "a journey page entry" });
          }
        }
      }
    }
  }
  for (let s = 0; s < starts.length; s += 1) {
    const first = starts[s] as { node: unknown; where: string };
    const stack: Array<{ node: unknown; level: number; where: string }> = [{ node: first.node, level: 1, where: first.where }];
    while (stack.length > 0) {
      const top = stack.pop() as { node: unknown; level: number; where: string };
      if (top.level > limit) {
        return top.where;
      }
      const children = (top.node as { children?: unknown }).children;
      if (children === null || typeof children !== "object" || Array.isArray(children)) {
        continue;
      }
      const slots = Object.keys(children as object);
      for (let k = 0; k < slots.length; k += 1) {
        const list = (children as Record<string, unknown>)[slots[k] as string];
        if (!Array.isArray(list)) {
          continue;
        }
        for (let i = 0; i < list.length; i += 1) {
          const child = list[i] as { id?: unknown } | null;
          if (child !== null && typeof child === "object" && !Array.isArray(child)) {
            stack.push({ node: child, level: top.level + 1, where: top.where + " > " + slots[k] + " > " + (typeof child.id === "string" ? child.id : "#" + i) });
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Whether the compile honours `source` under `key` as a server-secret rule: one of the six
 * kernel-applied keys, written in the object form with `run: "server-secret"`. A browser-only
 * key compiles to `both` (reported), so it is not secret; nor is a key the compile does not read.
 */
export function kernelIsSecretRule(key: string, source: unknown): boolean {
  return kernelIsServerRuleKey(key) && kernelRuleRun(source) === "server-secret";
}

/**
 * A deep copy of the form tree with every rule the compile honours as `server-secret` removed,
 * key and all ({@link kernelIsSecretRule}: the same reading as {@link kernelCompileRules}, so
 * what the browser is served and what it would apply agree). Nothing else changes: other rules
 * keep their `run`, the field itself stays, other keys under `rules` are copied as written. What
 * a host serves to a browser.
 */
export function kernelStripSecretRules(root: ComponentNode): ComponentNode {
  return kernelCopyTree(root, function (one: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...one };
    if (kernelIsPlainRecord(one.rules)) {
      const rules: Record<string, unknown> = {};
      for (const key of Object.keys(one.rules)) {
        const source = one.rules[key];
        if (!kernelIsSecretRule(key, source)) {
          rules[key] = source;
        }
      }
      copy.rules = rules;
    }
    return copy;
  }) as ComponentNode;
}

/**
 * A deep copy of a journey or PDF section with every value that is marked `run: "server-secret"`
 * removed from the record holding it. No rule written there may take a server scope
 * (the compile reports such a `run` as `runScope` and runs the rule on both sides), but the text
 * would still reach the browser in the public copy, so it is taken out: a route `when`, a
 * worked-out value, a layout `when`, a field or area `source.expression`, an own node's rule.
 * Anything else is copied as written (an own `__proto__` key stays a key). Walked with an
 * explicit stack.
 */
export function kernelStripSecretSources(section: unknown): unknown {
  const holder: unknown[] = [undefined];
  const stack: Array<{ node: unknown; into: unknown; at: number | string }> = [{ node: section, into: holder, at: 0 }];
  const put = function (into: unknown, at: number | string, value: unknown): void {
    Object.defineProperty(into as object, at, { value, enumerable: true, writable: true, configurable: true });
  };
  while (stack.length > 0) {
    const item = stack.pop() as { node: unknown; into: unknown; at: number | string };
    if (Array.isArray(item.node)) {
      const copy: unknown[] = [];
      put(item.into, item.at, copy);
      for (let index = 0; index < item.node.length; index += 1) {
        copy.push(undefined);
        stack.push({ node: item.node[index], into: copy, at: index });
      }
    } else if (kernelIsPlainRecord(item.node)) {
      const copy: Record<string, unknown> = {};
      put(item.into, item.at, copy);
      for (const key of Object.keys(item.node)) {
        const value = item.node[key];
        if (kernelIsPlainRecord(value) && value.run === "server-secret") {
          continue;
        }
        // The key is placed now, so the copy keeps the order the section was written in.
        put(copy, key, undefined);
        stack.push({ node: value, into: copy, at: key });
      }
    } else {
      put(item.into, item.at, item.node);
    }
  }
  return holder[0];
}

/**
 * The journey section as {@link kernelStripSecretSources} copies it, except that a page whose
 * `when` was stripped keeps the key, as `null`. A page has no condition of its own, so the shape
 * check refuses any page `when`; a placeholder keeps the browser's copy refused as the author's
 * is on the server, rather than a journey the browser runs and every submission fails.
 */
export function kernelStripSecretJourney(section: unknown): unknown {
  const copy = kernelStripSecretSources(section);
  if (!kernelIsPlainRecord(section) || !Array.isArray(section.journeys) || !kernelIsPlainRecord(copy) || !Array.isArray(copy.journeys)) {
    return copy;
  }
  for (let j = 0; j < section.journeys.length; j += 1) {
    const journey = section.journeys[j];
    const journeyCopy = copy.journeys[j];
    if (!kernelIsPlainRecord(journey) || !Array.isArray(journey.pages) || !kernelIsPlainRecord(journeyCopy) || !Array.isArray(journeyCopy.pages)) {
      continue;
    }
    for (let p = 0; p < journey.pages.length; p += 1) {
      const page = journey.pages[p];
      const pageCopy = journeyCopy.pages[p];
      if (kernelIsPlainRecord(page) && page.when !== undefined && kernelIsPlainRecord(pageCopy) && pageCopy.when === undefined) {
        pageCopy.when = null;
      }
    }
  }
  return copy;
}

/** Whether a journey or PDF section holds a value marked `run: "server-secret"` anywhere ({@link kernelStripSecretSources}). */
export function kernelHoldsSecretSource(section: unknown): boolean {
  const stack: unknown[] = [section];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        stack.push(node[index]);
      }
    } else if (kernelIsPlainRecord(node)) {
      if (node.run === "server-secret") {
        return true;
      }
      for (const key of Object.keys(node)) {
        stack.push(node[key]);
      }
    }
  }
  return false;
}

/**
 * The formulaErrors word a host or a form wrote: the host's when it is `warn` or `fail`, else
 * the form's `configuration.formulaErrors` when it is one of the two, else undefined. Any other
 * value is no word at all.
 */
export function kernelFormulaWord(rootConfiguration: unknown, hostOption: unknown): FormulaErrorPolicy | undefined {
  if (hostOption === "warn" || hostOption === "fail") {
    return hostOption;
  }
  if (kernelIsPlainRecord(rootConfiguration)) {
    const word = rootConfiguration.formulaErrors;
    if (word === "warn" || word === "fail") {
      return word;
    }
  }
  return undefined;
}

/**
 * Which policy applies to a formula problem: the host's word when it gives one, else the
 * form's `configuration.formulaErrors`, else `"fail"` (the default refuses, on every
 * side).
 */
export function kernelFormulaPolicy(rootConfiguration: unknown, hostOption: unknown): FormulaErrorPolicy {
  return kernelFormulaWord(rootConfiguration, hostOption) === "warn" ? "warn" : "fail";
}

/**
 * The definition a host serves to a browser: the root without the rules the compile honours as
 * `server-secret` (a form component's `visibleWhen`, `requiredWhen`, `enabledWhen`,
 * `readonlyWhen` or `value` written `{ run: "server-secret" }`, also inside a children slot that is
 * not a list). A value marked `server-secret` in the journeys or the PDF layouts is
 * removed too: no rule there may take a server scope (the compile reports such a `run` as
 * `runScope` and runs the rule on both sides), but its text would still reach the browser.
 */
export function publicDefinition(definition: FormDefinition): FormDefinition {
  // Over the root as the run reads it, every data grid bound; the sandbox's `public`
  // op serves the same tree.
  const copy: Record<string, unknown> = { ...definition, root: kernelStripSecretRules(normalizeDataGrids(definition.root)) };
  // A secret rule written where no server scope is allowed is served nowhere either.
  if (definition.journey !== undefined) {
    copy.journey = kernelStripSecretJourney(definition.journey);
  }
  if (definition.pdf !== undefined) {
    copy.pdf = kernelStripSecretSources(definition.pdf);
  }
  // The form's tests are the author's: a scenario names rules, answers
  // and expected verdicts, so the running form never carries them to a browser.
  delete copy.tests;
  return copy as unknown as FormDefinition;
}

/**
 * Whether the rule a compile problem sits at runs on the server: `where` is
 * `rules:<componentId>:<key>` and the author's own rule under that key (a string, or the object
 * form with its `run`) is one the server applies ({@link kernelRuleRunsOn}). Anything else (a
 * journey condition, a PDF layout, a browser-only key, a component the index lacks) is the
 * browser's alone.
 */
export function kernelProblemRunsOnServer(
  index: { nodeById: Record<string, ComponentNode> },
  where: string
): boolean {
  // Own members only (never `Object.prototype.constructor`); local, since this module imports no kernel code.
  const own = <T>(record: Record<string, T>, name: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
  if (where.indexOf("rules:") !== 0) {
    return false;
  }
  const cut = where.lastIndexOf(":");
  if (cut <= 6) {
    return false;
  }
  const node = own(index.nodeById, where.slice(6, cut));
  const key = where.slice(cut + 1);
  if (node === undefined || !node.rules || typeof node.rules !== "object") {
    return false;
  }
  return kernelRuleRunsOn(own(node.rules as Record<string, unknown>, key), key, "server");
}

/**
 * The quantifier written at `at` in a regular expression source: `*`, `+`, `?`, `{n}`, `{n,}` or
 * `{n,m}`, with an optional lazy `?` after it. `max` is `Infinity` when unbounded; `next` is the
 * index after it. `null` when none starts there (a `{` that is no quantifier is a literal).
 */
export function kernelRegexQuantifier(source: string, at: number): { min: number; max: number; next: number } | null {
  const ch = source.charAt(at);
  let min = 0;
  let max = 0;
  let next = at + 1;
  if (ch === "*") {
    max = Infinity;
  } else if (ch === "+") {
    min = 1;
    max = Infinity;
  } else if (ch === "?") {
    max = 1;
  } else if (ch === "{") {
    // Only digits and a comma can sit inside the braces, so the scan stops at the first other
    // character: a run of `{` costs one step each, however long.
    let close = at + 1;
    while (close < source.length && /[0-9,]/.test(source.charAt(close))) {
      close += 1;
    }
    if (source.charAt(close) !== "}") {
      return null;
    }
    const body = source.slice(at + 1, close);
    const comma = body.indexOf(",");
    const low = comma < 0 ? body : body.slice(0, comma);
    const high = comma < 0 ? body : body.slice(comma + 1);
    if (low === "" || !/^[0-9]+$/.test(low) || (comma >= 0 && high !== "" && !/^[0-9]+$/.test(high))) {
      return null;
    }
    min = Number(low);
    max = comma >= 0 && high === "" ? Infinity : Number(high);
    next = close + 1;
  } else {
    return null;
  }
  if (source.charAt(next) === "?") {
    next += 1;
  }
  return { min, max, next };
}

/**
 * One node of a parsed regular expression ({@link kernelRegexParse}): an atom (`lit` a character,
 * `cls` a class or `\d`-style escape, `any` the dot or a `\p{...}`, `ref` a back-reference, `zero`
 * an anchor or `\b`) or a `group` (`alts` its branches, `look` a lookaround). `first` and
 * `nullable` are the cached answers of {@link kernelRegexGroupInfo}.
 */
interface KernelRegexNode {
  kind: string;
  cp: number;
  neg: boolean;
  items: number[];
  builtin: string;
  alts: KernelRegexElement[][];
  look: boolean;
  nullable: boolean;
  first: KernelRegexNode[] | null;
}

/** A node with its repeat bounds and the span of its source (quantifier included). */
interface KernelRegexElement {
  node: KernelRegexNode;
  min: number;
  max: number;
  start: number;
  end: number;
}

/** The source under analysis and the steps left before the analysis gives up (and says risky). */
interface KernelRegexRun {
  source: string;
  left: number;
}

/** An empty {@link KernelRegexNode} of `kind`. */
export function kernelRegexNode(kind: string): KernelRegexNode {
  return { kind, cp: 0, neg: false, items: [], builtin: "", alts: [], look: false, nullable: false, first: null };
}

/**
 * The escape written at `at` (a backslash) in a regular expression source, as an atom, and the
 * index after it; `null` when the source ends there or the escape is malformed. Inside a class
 * (`inClass`) a back-reference and `\b` are not read as such.
 */
export function kernelRegexEscape(source: string, at: number, inClass: boolean): { node: KernelRegexNode; next: number } | null {
  const c = source.charAt(at + 1);
  if (c === "") {
    return null;
  }
  let next = at + 2;
  if (!inClass && c >= "1" && c <= "9") {
    while (/[0-9]/.test(source.charAt(next))) {
      next += 1;
    }
    return { node: kernelRegexNode("ref"), next };
  }
  if (!inClass && c === "k" && source.charAt(at + 2) === "<") {
    const close = source.indexOf(">", at);
    return close < 0 ? null : { node: kernelRegexNode("ref"), next: close + 1 };
  }
  if (!inClass && (c === "b" || c === "B")) {
    return { node: kernelRegexNode("zero"), next };
  }
  if ("dDwWsS".indexOf(c) >= 0) {
    const set = kernelRegexNode("cls");
    set.builtin = c;
    return { node: set, next };
  }
  if (c === "p" || c === "P") {
    if (source.charAt(at + 2) === "{") {
      const close = source.indexOf("}", at);
      if (close < 0) {
        return null;
      }
      // A property this reader models is its set (`\P` the complement); any other is "anything".
      const ranges = kernelRegexProperty(source.slice(at + 3, close));
      if (ranges === null) {
        return { node: kernelRegexNode("any"), next: close + 1 };
      }
      const set = kernelRegexNode("cls");
      set.items = ranges;
      set.neg = c === "P";
      return { node: set, next: close + 1 };
    }
  }
  const lit = kernelRegexNode("lit");
  const hit = "ntrfv0".indexOf(c);
  if (hit >= 0) {
    lit.cp = [10, 9, 13, 12, 11, 0][hit] as number;
  } else if (c === "b") {
    lit.cp = 8;
  } else if (c === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(at + 2, at + 4))) {
    lit.cp = parseInt(source.slice(at + 2, at + 4), 16);
    next = at + 4;
  } else if (c === "u" && source.charAt(at + 2) === "{" && source.indexOf("}", at) > at + 2 && /^[0-9a-fA-F]+$/.test(source.slice(at + 3, source.indexOf("}", at)))) {
    // A closing brace is required: without one `indexOf` is -1 and the cursor used to fall back
    // to 0 for ever.
    const close = source.indexOf("}", at);
    lit.cp = parseInt(source.slice(at + 3, close), 16);
    next = close + 1;
  } else if (c === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(at + 2, at + 6))) {
    lit.cp = parseInt(source.slice(at + 2, at + 6), 16);
    next = at + 6;
    // Under `u` a high surrogate escape followed by a low one is one character.
    if (lit.cp >= 0xd800 && lit.cp <= 0xdbff && source.slice(at + 6, at + 8) === "\\u" && /^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(source.slice(at + 8, at + 12))) {
      lit.cp = (lit.cp - 0xd800) * 0x400 + (parseInt(source.slice(at + 8, at + 12), 16) - 0xdc00) + 0x10000;
      next = at + 12;
    }
  } else if (c === "c" && /^[A-Za-z]$/.test(source.charAt(at + 2))) {
    lit.cp = source.charCodeAt(at + 2) % 32;
    next = at + 3;
  } else {
    lit.cp = source.charCodeAt(at + 1);
  }
  return { node: lit, next };
}

/**
 * The code point ranges (pairs, inclusive) of a Unicode property named in `\p{...}`, or `null`
 * for one this reader does not model (it then stands for anything). Broad on purpose: a set may
 * hold a few characters the property lacks, never lack one it has, so an overlap is never missed;
 * the letter, number, punctuation and separator sets are what name and address patterns use.
 */
export function kernelRegexProperty(name: string): number[] | null {
  let key = name;
  const eq = key.indexOf("=");
  if (eq >= 0) {
    const head = key.slice(0, eq);
    if (head !== "General_Category" && head !== "gc") {
      return null;
    }
    key = key.slice(eq + 1);
  }
  switch (key) {
    case "L":
    case "Letter":
      return [65, 90, 97, 122, 0xaa, 0xaa, 0xb5, 0xb5, 0xba, 0xba, 0xc0, 0xd6, 0xd8, 0xf6, 0xf8, 0x167f, 0x1681, 0x1fff, 0x2c00, 0x2dff, 0x3005, 0x3006, 0x3031, 0x3035, 0x3041, 0x318f, 0x31a0, 0x31ff, 0x3400, 0xd7ff, 0xf900, 0xfdff, 0xfe70, 0xfefc, 0xff21, 0xff3a, 0xff41, 0xff5a, 0xff66, 0xffdc, 0x10000, 0x1efff, 0x20000, 0x3ffff];
    case "Lu":
    case "Uppercase_Letter":
      return [65, 90, 0xc0, 0xd6, 0xd8, 0xde, 0x391, 0x3a9, 0x410, 0x42f];
    case "Ll":
    case "Lowercase_Letter":
      return [97, 122, 0xb5, 0xb5, 0xdf, 0xf6, 0xf8, 0xff, 0x3b1, 0x3c9, 0x430, 0x45f];
    case "N":
    case "Number":
      return [48, 57, 0xb2, 0xb3, 0xb9, 0xb9, 0xbc, 0xbe, 0x660, 0x669, 0x6f0, 0x6f9, 0x966, 0x96f, 0x2070, 0x2079, 0x2080, 0x2089, 0x2150, 0x218f, 0x2460, 0x249b, 0xff10, 0xff19];
    case "Nd":
    case "Decimal_Number":
      return [48, 57, 0x660, 0x669, 0x6f0, 0x6f9, 0x966, 0x96f, 0xff10, 0xff19];
    case "P":
    case "Punctuation":
      return [33, 35, 37, 42, 44, 47, 58, 59, 63, 64, 91, 93, 95, 95, 123, 123, 125, 125, 0xa1, 0xa1, 0xa7, 0xa7, 0xab, 0xab, 0xb6, 0xb7, 0xbb, 0xbb, 0xbf, 0xbf, 0x2010, 0x2027, 0x2030, 0x205e, 0x3001, 0x3003, 0x3008, 0x3011];
    case "Z":
    case "Separator":
      return [32, 32, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000];
    default:
      return null;
  }
}

/** Adds the escape `from` (`\d`, `\p{L}`, ...) to the class `into`; a negated property stands for anything. */
export function kernelRegexMerge(into: KernelRegexNode, from: KernelRegexNode): void {
  if (from.kind === "cls" && !from.neg) {
    into.builtin += from.builtin;
    for (let k = 0; k < from.items.length; k += 1) {
      into.items.push(from.items[k] as number);
    }
  } else {
    into.builtin += "P";
  }
}

/**
 * The class written at `at` (a `[`) in a regular expression source, and the index after its `]`;
 * `null` when it is not closed. Ranges are kept as pairs in `items`, `\d`-style escapes as letters
 * in `builtin` (`P` for a property escape this reader does not model, or a negated one, which
 * stands for anything; a modelled property adds its ranges to `items`).
 */
export function kernelRegexClass(source: string, at: number): { node: KernelRegexNode; next: number } | null {
  const node = kernelRegexNode("cls");
  const size = source.length;
  let j = at + 1;
  if (source.charAt(j) === "^") {
    node.neg = true;
    j += 1;
  }
  for (;;) {
    if (j >= size) {
      return null;
    }
    if (source.charAt(j) === "]") {
      return { node, next: j + 1 };
    }
    let lo = 0;
    if (source.charAt(j) === "\\") {
      const escape = kernelRegexEscape(source, j, true);
      if (escape === null) {
        return null;
      }
      if (escape.next <= j) {
        return null;
      }
      j = escape.next;
      if (escape.node.kind !== "lit") {
        kernelRegexMerge(node, escape.node);
        continue;
      }
      lo = escape.node.cp;
    } else {
      // By code point: an astral character is one endpoint, not two surrogates.
      lo = source.codePointAt(j) as number;
      j += lo > 0xffff ? 2 : 1;
    }
    if (source.charAt(j) === "-" && j + 1 < size && source.charAt(j + 1) !== "]") {
      let hi = 0;
      let k = j + 1;
      if (source.charAt(k) === "\\") {
        const escape = kernelRegexEscape(source, k, true);
        if (escape === null) {
          return null;
        }
        k = escape.next;
        if (escape.node.kind !== "lit") {
          // `[a-\d]`: a, a hyphen and the class.
          node.items.push(lo, lo, 45, 45);
          kernelRegexMerge(node, escape.node);
          j = k;
          continue;
        }
        hi = escape.node.cp;
      } else {
        hi = source.codePointAt(k) as number;
        k += hi > 0xffff ? 2 : 1;
      }
      node.items.push(Math.min(lo, hi), Math.max(lo, hi));
      j = k;
      continue;
    }
    node.items.push(lo, lo);
  }
}

/**
 * A regular expression source as a tree of branches, elements and groups, or `null` when it is
 * not well formed (a stray parenthesis, an unclosed class, a trailing backslash: the pattern's own
 * compile refuses those) and `"deep"` when groups nest more than 32 deep. An explicit stack, so a
 * long or deeply nested source is no recursion; the tree is at most 32 groups deep, which keeps
 * the passes that walk it recursively inside the guest's stack.
 */
export function kernelRegexParse(source: string): KernelRegexNode | "deep" | null {
  const size = source.length;
  const root = kernelRegexNode("group");
  const frames: { group: KernelRegexNode; seq: KernelRegexElement[]; from: number }[] = [{ group: root, seq: [], from: 0 }];
  let i = 0;
  let last = -1;
  while (i < size) {
    // The cursor moves on at every turn; one that does not is a bug in a branch below, and the
    // source then reads as unreadable (risky) instead of looping for ever.
    if (i <= last) {
      return null;
    }
    last = i;
    const frame = frames[frames.length - 1] as (typeof frames)[number];
    const ch = source.charAt(i);
    let from = i;
    let node: KernelRegexNode;
    if (ch === "|") {
      frame.group.alts.push(frame.seq);
      frame.seq = [];
      i += 1;
      continue;
    } else if (ch === "(") {
      const group = kernelRegexNode("group");
      i += 1;
      if (source.charAt(i) === "?") {
        const kind = source.charAt(i + 1);
        if (kind === ":") {
          i += 2;
        } else if (kind === "=" || kind === "!") {
          group.look = true;
          i += 2;
        } else if (kind === "<" && (source.charAt(i + 2) === "=" || source.charAt(i + 2) === "!")) {
          group.look = true;
          i += 3;
        } else if (kind === "<") {
          const close = source.indexOf(">", i);
          if (close < 0) {
            return null;
          }
          i = close + 1;
        } else {
          // `(?i:`, `(?-s:`, `(?i-m:` (regexp modifiers) are a plain group here.
          const flags = /^\?[ims]*(-[ims]*)?:/.exec(source.slice(i, i + 10));
          if (flags === null) {
            return null;
          }
          i += flags[0].length;
        }
      }
      if (frames.length > 32) {
        return "deep";
      }
      frames.push({ group, seq: [], from });
      continue;
    } else if (ch === ")") {
      if (frames.length === 1) {
        return null;
      }
      const done = frames.pop() as (typeof frames)[number];
      done.group.alts.push(done.seq);
      node = done.group;
      from = done.from;
      i += 1;
    } else if (ch === "\\") {
      const escape = kernelRegexEscape(source, i, false);
      if (escape === null) {
        return null;
      }
      node = escape.node;
      i = escape.next;
    } else if (ch === "[") {
      const set = kernelRegexClass(source, i);
      if (set === null) {
        return null;
      }
      node = set.node;
      i = set.next;
    } else if (ch === ".") {
      node = kernelRegexNode("any");
      i += 1;
    } else if (ch === "^" || ch === "$") {
      node = kernelRegexNode("zero");
      i += 1;
    } else {
      // A character is read whole, an astral one as one atom, so a repeat binds to all of it.
      node = kernelRegexNode("lit");
      node.cp = source.codePointAt(i) as number;
      i += node.cp > 0xffff ? 2 : 1;
    }
    let min = 1;
    let max = 1;
    const quantifier = kernelRegexQuantifier(source, i);
    if (quantifier !== null) {
      i = quantifier.next;
      if (node.kind !== "zero" && !node.look) {
        min = quantifier.min;
        max = quantifier.max;
      }
    }
    (frames[frames.length - 1] as (typeof frames)[number]).seq.push({ node, min, max, start: from, end: i });
  }
  if (frames.length > 1) {
    return null;
  }
  root.alts.push((frames[0] as (typeof frames)[number]).seq);
  return root;
}

/** Whether the escape letter `letter` (`d`, `D`, `w`, `W`, `s`, `S`, or `P` for anything) takes `cp`. */
export function kernelRegexBuiltin(letter: string, cp: number): boolean {
  if (letter === "P") {
    return true;
  }
  const lower = letter.toLowerCase();
  let inside = false;
  if (lower === "d") {
    inside = cp >= 48 && cp <= 57;
  } else if (lower === "w") {
    inside = (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
  } else {
    inside = (cp >= 9 && cp <= 13) || cp === 32 || cp === 160 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff;
  }
  return letter === lower ? inside : !inside;
}

/** Whether the atom `node` takes the character `cp`. */
export function kernelRegexHas(node: KernelRegexNode, cp: number): boolean {
  if (node.kind === "any" || node.kind === "ref") {
    return true;
  }
  if (node.kind === "lit") {
    return node.cp === cp;
  }
  let inside = false;
  for (let k = 0; k < node.items.length && !inside; k += 2) {
    inside = cp >= (node.items[k] as number) && cp <= (node.items[k + 1] as number);
  }
  for (let k = 0; k < node.builtin.length && !inside; k += 1) {
    inside = kernelRegexBuiltin(node.builtin.charAt(k), cp);
  }
  return inside !== node.neg;
}

/**
 * Whether two atoms can take the same character. Decided on a fixed set of probe characters (the
 * edges of the digit, letter, space and punctuation classes) and the ends of every range and
 * literal either atom names, which is exact for the classes a pattern is written with.
 */
export function kernelRegexMeets(a: KernelRegexNode, b: KernelRegexNode): boolean {
  if (a.kind === "lit" && b.kind === "lit") {
    return a.cp === b.cp;
  }
  const probes = [0, 9, 10, 13, 32, 45, 46, 47, 48, 57, 58, 64, 65, 90, 91, 95, 96, 97, 122, 123, 160, 233, 0x2028, 0x4e00, 0x1f600];
  const both = [a, b];
  for (let n = 0; n < 2; n += 1) {
    const one = both[n] as KernelRegexNode;
    if (one.kind === "lit") {
      probes.push(one.cp);
    }
    for (let k = 0; k < one.items.length; k += 1) {
      const end = one.items[k] as number;
      probes.push(end - 1, end, end + 1);
    }
  }
  for (let p = 0; p < probes.length; p += 1) {
    if (kernelRegexHas(a, probes[p] as number) && kernelRegexHas(b, probes[p] as number)) {
      return true;
    }
  }
  return false;
}

/** The union of two sets of atoms; a set that would pass 64 atoms becomes "anything" (the safe side). */
export function kernelRegexUnion(a: KernelRegexNode[], b: KernelRegexNode[]): KernelRegexNode[] {
  if (b.length === 0) {
    return a;
  }
  if (a.length === 0) {
    return b;
  }
  return a.length + b.length > 64 ? [kernelRegexNode("any")] : a.concat(b);
}

/**
 * Whether a character of `a` can also be one of `b`; a run out of steps answers yes (the safe
 * side). A pair costs a step, and more when the two hold many ranges (the probe work grows with
 * their square), so the budget bounds time and not only the count.
 */
export function kernelRegexSetsMeet(run: KernelRegexRun, a: KernelRegexNode[], b: KernelRegexNode[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      const size = (a[i] as KernelRegexNode).items.length + (b[j] as KernelRegexNode).items.length;
      run.left -= 1 + Math.floor((size * size) / 64);
      if (run.left < 0 || kernelRegexMeets(a[i] as KernelRegexNode, b[j] as KernelRegexNode)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether an element takes no character: an anchor, `\b` or a lookaround. */
export function kernelRegexIsZero(element: KernelRegexElement): boolean {
  return element.node.kind === "zero" || element.node.look;
}

/** What an element can start with (`first`) and whether it can match nothing (`nullable`). */
export function kernelRegexElementInfo(element: KernelRegexElement): { first: KernelRegexNode[]; nullable: boolean } {
  const node = element.node;
  if (kernelRegexIsZero(element)) {
    return { first: [], nullable: true };
  }
  if (node.kind === "group") {
    kernelRegexGroupInfo(node);
    return { first: node.first as KernelRegexNode[], nullable: element.min === 0 || node.nullable };
  }
  return { first: [node], nullable: element.min === 0 };
}

/** What the elements of `seq` from `from` on can start with, up to the first that must match. */
export function kernelRegexSeqFirst(seq: KernelRegexElement[], from: number): { first: KernelRegexNode[]; nullable: boolean } {
  let first: KernelRegexNode[] = [];
  for (let k = from; k < seq.length; k += 1) {
    const info = kernelRegexElementInfo(seq[k] as KernelRegexElement);
    first = kernelRegexUnion(first, info.first);
    if (!info.nullable) {
      return { first, nullable: false };
    }
  }
  return { first, nullable: true };
}

/** Fills `first` and `nullable` of a group, once. */
export function kernelRegexGroupInfo(group: KernelRegexNode): void {
  if (group.first !== null) {
    return;
  }
  let first: KernelRegexNode[] = [];
  let nullable = false;
  for (let a = 0; a < group.alts.length; a += 1) {
    const one = kernelRegexSeqFirst(group.alts[a] as KernelRegexElement[], 0);
    first = kernelRegexUnion(first, one.first);
    nullable = nullable || one.nullable;
  }
  group.first = first;
  group.nullable = nullable;
}

/**
 * Whether two branches of an alternation can take the same text: read element by element, the
 * same element (same source) is skipped, elements that cannot start alike end it (`false`), and a
 * quantified or grouped pair that can start alike is taken to overlap. A branch that is a prefix of
 * the other overlaps it when what is left of the other can start what follows the alternation
 * (`cont`) or can match nothing: `a|a`, `a|aa`, `\d|\d\d`, `a|a?` overlap; `a|b`, `ab|ac`, `a|ab`
 * (inside a repeat of the whole) do not.
 */
export function kernelRegexBranchesOverlap(run: KernelRegexRun, sa: KernelRegexElement[], sb: KernelRegexElement[], cont: KernelRegexNode[]): boolean {
  let x = 0;
  let y = 0;
  for (;;) {
    while (x < sa.length && kernelRegexIsZero(sa[x] as KernelRegexElement)) {
      x += 1;
    }
    while (y < sb.length && kernelRegexIsZero(sb[y] as KernelRegexElement)) {
      y += 1;
    }
    run.left -= 1;
    if (run.left < 0 || (x >= sa.length && y >= sb.length)) {
      return true;
    }
    if (x >= sa.length || y >= sb.length) {
      const rest = x >= sa.length ? kernelRegexSeqFirst(sb, y) : kernelRegexSeqFirst(sa, x);
      return rest.nullable || kernelRegexSetsMeet(run, rest.first, cont);
    }
    const ea = sa[x] as KernelRegexElement;
    const eb = sb[y] as KernelRegexElement;
    if (run.source.slice(ea.start, ea.end) === run.source.slice(eb.start, eb.end)) {
      x += 1;
      y += 1;
      continue;
    }
    const ia = kernelRegexElementInfo(ea);
    const ib = kernelRegexElementInfo(eb);
    if (ia.nullable || ib.nullable) {
      const fa = kernelRegexSeqFirst(sa, x);
      const fb = kernelRegexSeqFirst(sb, y);
      return fa.nullable || fb.nullable || kernelRegexSetsMeet(run, fa.first, fb.first);
    }
    if (!kernelRegexSetsMeet(run, ia.first, ib.first)) {
      return false;
    }
    if (ea.node.kind === "group" || eb.node.kind === "group" || ea.min !== 1 || ea.max !== 1 || eb.min !== 1 || eb.max !== 1) {
      return true;
    }
    x += 1;
    y += 1;
  }
}

/**
 * For each element of `seq`, what can come right after it: the first atoms of the elements behind
 * it, up to one that must match, then `outer` (what follows the sequence) when all of them can
 * match nothing.
 */
export function kernelRegexFollow(run: KernelRegexRun, seq: KernelRegexElement[], outer: KernelRegexNode[]): KernelRegexNode[][] {
  const follow: KernelRegexNode[][] = [];
  let after = outer;
  for (let k = seq.length - 1; k >= 0; k -= 1) {
    follow[k] = after;
    const info = kernelRegexElementInfo(seq[k] as KernelRegexElement);
    after = info.nullable ? kernelRegexUnion(info.first, after) : info.first;
    run.left -= 1;
  }
  return follow;
}

/**
 * The body of a repeated group, read for the two shapes that make a repeat take exponential or
 * high-degree time: an element repeated a varying number of times (`+`, `*`, `?`, `{1,3}`, `{2,}`;
 * not `{3}`) whose characters can also start what comes
 * after it (the rest of its branch, then, when that can match nothing, `outer`: the next turn of
 * the loop), so the text can be cut between its repeats in many ways (`(a+)+`, `(\w+\s?)+`,
 * `(.*a){16}`); and an alternation with two branches that can take the same text
 * ({@link kernelRegexBranchesOverlap}), here or in a group inside. Recursive, at most 33 deep
 * ({@link kernelRegexParse}).
 */
export function kernelRegexScan(run: KernelRegexRun, group: KernelRegexNode, outer: KernelRegexNode[], counted: boolean): boolean {
  for (let a = 0; a < group.alts.length; a += 1) {
    const seq = group.alts[a] as KernelRegexElement[];
    const follow = kernelRegexFollow(run, seq, outer);
    // A lone `?` can take nothing; a turn of the loop that takes nothing is not a turn, so it
    // splits the text only beside something the branch must match (`([ab]a?)+`, not `((a|b)?)+`).
    let mustMatch = false;
    for (let k = 0; k < seq.length; k += 1) {
      mustMatch = mustMatch || (!kernelRegexIsZero(seq[k] as KernelRegexElement) && !kernelRegexElementInfo(seq[k] as KernelRegexElement).nullable);
    }
    for (let k = 0; k < seq.length; k += 1) {
      const element = seq[k] as KernelRegexElement;
      if (kernelRegexIsZero(element)) {
        continue;
      }
      // A repeat whose count can vary (`+`, `*`, `{1,3}`, `{0,2}`, not `{2}`) cuts the text in several ways.
      // In a group repeated a few times (`counted`, 3 to 7) only an unbounded repeat grows with the text (`(a+){7}`).
      if (element.min !== element.max && (counted ? element.max === Infinity : element.max > 1 || mustMatch) && kernelRegexSetsMeet(run, kernelRegexElementInfo(element).first, follow[k] as KernelRegexNode[])) {
        return true;
      }
      if (element.node.kind === "group" && kernelRegexScan(run, element.node, follow[k] as KernelRegexNode[], counted)) {
        return true;
      }
    }
  }
  // Branches that overlap give a constant factor per turn of a group repeated a few times: only a loop without bound is cut.
  if (group.alts.length > 1 && !counted) {
    for (let x = 0; x < group.alts.length; x += 1) {
      for (let y = x + 1; y < group.alts.length; y += 1) {
        if (kernelRegexBranchesOverlap(run, group.alts[x] as KernelRegexElement[], group.alts[y] as KernelRegexElement[], outer)) {
          return true;
        }
      }
    }
  }
  return run.left < 0;
}

/**
 * Whether a group repeated 8 or more times, or without bound, is a risky loop (and one repeated 3
 * to 7 times when it holds a repeat without bound that can cut the text: `(a+){7}` is a polynomial
 * of degree 7): its body can match
 * nothing and has more than one way to (`(a|b|)*`, `(a?b?)*`, `(a|a?)+`), or
 * {@link kernelRegexScan} finds the cuts or the overlapping branches.
 */
export function kernelRegexLoopRisky(run: KernelRegexRun, element: KernelRegexElement, mult: number, minMult: number): boolean {
  if (element.max < 3 && mult * element.max < 3) {
    return false;
  }
  const group = element.node;
  kernelRegexGroupInfo(group);
  // `mult` is how many times the groups around this one repeat it at most (`Infinity` under a
  // loop without bound), `minMult` how many times at least: `((a?b?){3}){7}c` repeats its inner
  // group 21 times.
  const most = element.max * mult;
  const least = element.min * minMult;
  // A group repeated 8 or more times that can match nothing in several ways is as bad as an unbounded one: `(a?b?){20}c` took 31 s on 20 characters.
  if ((most === Infinity || most >= 8) && group.nullable) {
    // Empty turns are cut only once the minimum is met, so a group that must turn 8 or more times and can match nothing splits the text however little it holds: `(a?){25}a{25}c`.
    // Under a loop without bound, a group turned twice or more that can match nothing does the same: `((a?b?){3})*c`.
    if (least >= 8 || (mult === Infinity && element.max > 1) || group.alts.length > 1) {
      return true;
    }
    const only = group.alts[0] as KernelRegexElement[];
    let taking = 0;
    for (let k = 0; k < only.length; k += 1) {
      if (!kernelRegexIsZero(only[k] as KernelRegexElement)) {
        taking += 1;
      }
    }
    if (taking > 1) {
      return true;
    }
  }
  return kernelRegexScan(run, group, group.first as KernelRegexNode[], most < 8);
}

/**
 * Whether a sequence holds three or more unbounded repeats that overlap, a polynomial of degree
 * three or more on text that fails late (`a*a*a*b`, `\s*\s*\s*x`, `.*a.*a.*a`): each counts when its characters can also start what follows it in the sequence, or when
 * it directly follows a counted repeat that can take its characters. A last unbounded repeat,
 * with nothing behind it but the end, counts too once two before it do and it can take what
 * the element before it takes (`^\S+@\S+\.\S+$` and `.+@.+\..+` are cubic on text that fails at
 * the end). Two (`.+@.+\.com`) are only quadratic and pass.
 */
export function kernelRegexChain(run: KernelRegexRun, seq: KernelRegexElement[]): boolean {
  const follow = kernelRegexFollow(run, seq, []);
  let count = 0;
  let optional = 0;
  let before: KernelRegexNode[] | null = null;
  let previous: KernelRegexNode[] | null = null;
  for (let k = 0; k < seq.length; k += 1) {
    const element = seq[k] as KernelRegexElement;
    if (kernelRegexIsZero(element)) {
      continue;
    }
    let hit: KernelRegexNode[] | null = null;
    const info = kernelRegexElementInfo(element);
    const first = info.first;
    // A bounded optional (`a?`, `a{0,2}`) whose characters can also start what follows it doubles
    // the ways to cut the text at each such element: `a?` x 30 then `a` x 30 is exponential. A dozen of them in one sequence is risky; a few (`\d?\d?\d?-`) are cheap.
    // A wide one (`a{0,9}`) cuts the text in that many more ways, so it counts as the bits it takes to
    // say how much it took: log2(max + 1), one for `a?`; a group that can match nothing and turns a
    // few times (`(a?b?){7}`) counts its turns times the bits of what it holds, when it can also start
    // what comes before or after it.
    if (element.min === 0 && element.max !== Infinity && element.max >= 1 && kernelRegexSetsMeet(run, first, follow[k] as KernelRegexNode[])) {
      optional += Math.log2(element.max + 1);
    } else if (element.node.kind === "group" && !element.node.look && element.max > 1 && element.max !== Infinity) {
      kernelRegexGroupInfo(element.node);
      if (element.node.nullable && (kernelRegexSetsMeet(run, first, follow[k] as KernelRegexNode[]) || (previous !== null && kernelRegexSetsMeet(run, first, previous)))) {
        let holds = 1;
        for (let a = 0; a < element.node.alts.length; a += 1) {
          let taking = 0;
          const alt = element.node.alts[a] as KernelRegexElement[];
          for (let j = 0; j < alt.length; j += 1) {
            if (!kernelRegexIsZero(alt[j] as KernelRegexElement)) {
              taking += 1;
            }
          }
          holds = Math.max(holds, taking);
        }
        optional += element.max * Math.log2(holds + 1);
      }
    }
    if (element.max === Infinity) {
      if (
        kernelRegexSetsMeet(run, first, follow[k] as KernelRegexNode[]) ||
        (before !== null && kernelRegexSetsMeet(run, before, first)) ||
        (count >= 2 && (follow[k] as KernelRegexNode[]).length === 0 && previous !== null && kernelRegexSetsMeet(run, previous, first))
      ) {
        hit = first;
        count += 1;
      }
    }
    before = hit;
    // What may sit right before the next element: this one, and the ones behind it that can take nothing.
    previous = info.nullable && previous !== null ? kernelRegexUnion(previous, first) : first;
  }
  return count >= 3 || optional >= kernelRegexOptionalMax() || run.left < 0;
}

/** Overlapping bounded optional elements in one sequence the analysis tolerates (see {@link kernelRegexChain}). */
export function kernelRegexOptionalMax(): number {
  return 12;
}

/** Every repeated group and every repeated back-reference below `group`, checked. */
export function kernelRegexWalk(run: KernelRegexRun, group: KernelRegexNode, mult: number, minMult: number): boolean {
  for (let a = 0; a < group.alts.length; a += 1) {
    const seq = group.alts[a] as KernelRegexElement[];
    if (kernelRegexChain(run, seq)) {
      return true;
    }
    for (let k = 0; k < seq.length; k += 1) {
      const element = seq[k] as KernelRegexElement;
      if (element.node.kind === "ref") {
        if (element.max > 1) {
          return true;
        }
      } else if (element.node.kind === "group") {
        if (!element.node.look && element.max > 1 && kernelRegexLoopRisky(run, element, mult, minMult)) {
          return true;
        }
        // What is inside is turned as often as every group around it turns (a lookaround, once).
        if (kernelRegexWalk(run, element.node, element.node.look || element.max < 1 ? mult : mult * element.max, element.node.look ? minMult : minMult * element.min)) {
          return true;
        }
      }
    }
  }
  return run.left < 0;
}

/**
 * The steps the analysis may take before a source counts as risky: 3,000, which a QuickJS run
 * spends in about 50 ms (the 100-way alternation of disjoint classes, about 900 characters, takes
 * 10,000 steps and 143 ms; every pattern in the repo and the docs takes under 100).
 */
export function kernelRegexStepsMax(): number {
  return 3000;
}

/** The longest field `pattern` the kernel reads (a longer one is refused as risky; `component.pattern.tooLong` at Save). */
export function kernelRegexPatternMax(): number {
  return 2000;
}

/**
 * Whether a regular expression source has a shape that can take exponential (or high-degree
 * polynomial) time on some text. The source is parsed ({@link kernelRegexParse}: groups, branches,
 * quantifiers, classes) and every group repeated without bound, or 8 or more times, is read
 * ({@link kernelRegexLoopRisky}):
 * - an element repeated without bound whose characters can also start what follows it, the
 *   next turn of the loop included (`(a+)+`, `(a*)*`, `(\w+\s?)+`, `(x|y+)+`, `((ab)+)+`,
 *   `(.*a){16}`); a delimiter the repeat cannot take clears it (`(\d+\.)+`, `(\.[a-z]+)*`,
 *   `^([a-z0-9-]+\.){1,10}[a-z]{2,}$`, `^(\d+,){8}\d+$`);
 * - a branch that can match nothing beside another way to match (`(a|b|)*`, `(a?|b)+`, `(a?b?)*`,
 *   also behind groups: `((a)|(a?))+`);
 * - branches that can take the same text (`(a|a)+`, `(a|aa)+`, `(\d|\d\d)+`, also in a group
 *   inside the loop); disjoint branches (`(a|b)+`, `(ab|ac)+`) are not.
 * A back-reference with a repeat (`\1+`, `\k<name>*`, `\1{2,}`) is risky anywhere. Groups nested
 * more than 32 deep and a source that takes more than 3,000 steps to read ({@link kernelRegexStepsMax}) count as risky; a
 * source that is not a valid pattern answers `false` (the compile of the pattern refuses it on its
 * own). Never throws; the parse is linear, with an explicit stack.
 */
export function kernelRegexRisky(source: string): boolean {
  if (typeof source !== "string") {
    return false;
  }
  // Too long to read at the cost of one run (and to author by hand): refused, not parsed.
  if (source.length > kernelRegexPatternMax()) {
    return true;
  }
  const root = kernelRegexParse(source);
  if (root === null) {
    // A source this reader cannot follow, but the engine accepts as a pattern on its own, has
    // syntax it does not know: fail closed. One the engine refuses is the pattern compile's to
    // report.
    try {
      new RegExp(source, "u");
      return true;
    } catch {
      return false;
    }
  }
  if (root === "deep") {
    return true;
  }
  return kernelRegexWalk({ source, left: kernelRegexStepsMax() }, root, 1, 1);
}

/**
 * The first literal pattern of a `matches(text, "pattern")` call in `expression` that
 * {@link kernelRegexRisky} flags, else `undefined`. A pattern read from a field is not a
 * literal and is not looked at. Explicit stack, so a long chain is no recursion.
 */
export function kernelRiskyMatchesIn(expression: Expression): string | undefined {
  const stack: Expression[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop() as Expression;
    switch (node.kind) {
      case "unary":
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic":
        stack.push(node.right, node.left);
        break;
      case "call": {
        if (node.name === "matches" && node.args.length === 2) {
          const pattern = node.args[1] as Expression;
          if (pattern.kind === "literal" && typeof pattern.value === "string" && kernelRegexRisky(pattern.value)) {
            return pattern.value;
          }
        }
        for (let a = node.args.length - 1; a >= 0; a -= 1) {
          stack.push(node.args[a] as Expression);
        }
        break;
      }
      case "if":
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        for (let c = node.cases.length - 1; c >= 0; c -= 1) {
          const entry = node.cases[c] as { when: Expression; then: Expression };
          stack.push(entry.then, entry.when);
        }
        break;
      default:
        break;
    }
  }
  return undefined;
}

/** The plain-English line for a risky pattern, shared by the formula problem and the field one. */
export function kernelRiskyPatternMessage(pattern: string): string {
  return 'The pattern "' + pattern + '" repeats a repeat (or a back-reference), which can take very long on some text; rewrite it, or have the host allow risky patterns';
}

/**
 * A parser that refuses a formula holding a `matches` call with a literal risky pattern
 * (`pattern.risky`, params `pattern`, spanning the word `matches`) unless the host allows them
 * (`riskyPatterns: "allow"`; anything else reads as `"refuse"`). Wraps `parse` and nothing else;
 * a tree is not looked at.
 */
export function kernelRiskGuardParser(parse: FormulaParser, riskyPatterns: unknown): FormulaParser {
  if (riskyPatterns === "allow") {
    return parse;
  }
  return function (text: string, signatures: FormulaFunctionSignature[]): FormulaParseResult {
    const parsed = parse(text, signatures);
    if (!parsed.ok || parsed.expression === undefined) {
      return parsed;
    }
    const pattern = kernelRiskyMatchesIn(parsed.expression);
    if (pattern === undefined) {
      return parsed;
    }
    const at = text.indexOf("matches");
    return {
      ok: false,
      code: "pattern.risky",
      params: { pattern },
      message: kernelRiskyPatternMessage(pattern),
      start: at < 0 ? 0 : at,
      end: at < 0 ? text.length : at + 7
    };
  };
}

/** This module's kernel functions, for `PORTABLE_KERNEL_FUNCTIONS` and the PDF program. */
export const COMPILE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelCompileRulesOf,
  kernelIsPlainRecord,
  kernelIsExpressionTree,
  kernelExpressionFault,
  kernelIsRuleObject,
  kernelRuleShape,
  kernelIsRunScope,
  kernelIsBrowserOnlyRuleKey,
  kernelIsServerRuleKey,
  kernelIsRuleKey,
  kernelRuleExpression,
  kernelRuleRun,
  kernelRuleRunsOn,
  kernelProblemRunsOnServer,
  kernelRuleText,
  kernelCompileSource,
  kernelJsonTypeOf,
  kernelCompileSite,
  kernelCompileRules,
  kernelCopyTree,
  kernelCompileNode,
  kernelCompileJourneyEntry,
  kernelCompileWhen,
  kernelCompileJourney,
  kernelRiskyTreeSite,
  kernelPdfRiskyNodes,
  kernelCompilePdfBinding,
  kernelCompilePdf,
  kernelCompileDefinition,
  kernelCallResultKind,
  kernelConditionKind,
  kernelCompiledTreeOf,
  kernelTreeReadsRow,
  kernelPushConditionWarning,
  kernelConditionWarnings,
  kernelIsSecretRule,
  kernelMaxComponentDepth,
  kernelComponentTooDeep,
  kernelComponentTreeFault,
  kernelStripSecretRules,
  kernelStripSecretSources,
  kernelStripSecretJourney,
  kernelHoldsSecretSource,
  kernelFormulaWord,
  kernelFormulaPolicy,
  kernelRegexQuantifier,
  kernelRegexNode,
  kernelRegexEscape,
  kernelRegexProperty,
  kernelRegexMerge,
  kernelRegexClass,
  kernelRegexParse,
  kernelRegexBuiltin,
  kernelRegexHas,
  kernelRegexMeets,
  kernelRegexUnion,
  kernelRegexSetsMeet,
  kernelRegexIsZero,
  kernelRegexElementInfo,
  kernelRegexSeqFirst,
  kernelRegexGroupInfo,
  kernelRegexBranchesOverlap,
  kernelRegexFollow,
  kernelRegexScan,
  kernelRegexLoopRisky,
  kernelRegexChain,
  kernelRegexWalk,
  kernelRegexOptionalMax,
  kernelRegexPatternMax,
  kernelRegexStepsMax,
  kernelRegexRisky,
  kernelRiskyMatchesIn,
  kernelRiskyPatternMessage,
  kernelRiskGuardParser
];
