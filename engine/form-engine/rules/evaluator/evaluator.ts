import type { Expression } from "../../core/expressions/expression.js";
import { kernelIsDateAnswer } from "../../core/schema/answer-kinds.js";
import { kernelTextArg, kernelTextCall, kernelTextHandles, kernelTextHead, kernelTextLength, kernelTextOverCap } from "./functions-text.js";
import { kernelNumberCall, kernelNumberHandles } from "./functions-number.js";
import { kernelListCall, kernelListHandles, kernelMaxFormulaListItems } from "./functions-list.js";
import { kernelDateCall, kernelDateHandles } from "./functions-date.js";

/**
 * The rule expression evaluator.
 *
 * It runs in two places from the same source: the browser runtime imports it, and
 * the validation sandbox program splices its functions' source in beside the portable kernel
 * (`validation/wasm/portable-kernel.ts`), so a server re-validating a submission
 * reads a journey's conditions and a component's `visibleWhen` exactly as the browser did.
 * Hence the kernel's rules here: a type-only import for the AST, top-level `function`
 * declarations only, each referencing only other spliced functions and standard globals, and
 * no module constants. The spliced names carry the kernel's prefix so they cannot collide with
 * anything else in the program; {@link evaluateExpression} stays the public name.
 *
 * What this module calls from elsewhere is spliced too: `kernelIsDateAnswer`
 * (`core/schema/answer-kinds.ts`, through `ANSWER_KIND_FUNCTIONS`) decides when a comparison
 * orders two days by code unit, and the function library's groups (`functions-text.ts`,
 * `functions-number.ts`, `functions-list.ts`, `functions-date.ts`, through their own
 * `*_FUNCTIONS` lists) evaluate the functions the switch in {@link kernelExprCall} does not.
 * Nothing here reads a clock: the day is `context.today`, supplied by the host.
 */

export interface RuleEvaluationContext {
  /** Form-scoped values keyed by component id (or stringified instance path). */
  values: Record<string, unknown>;
  /** Row-scoped values for the current repeated instance (`row.` prefix). */
  rowValues?: Record<string, unknown>;
  /** Nearest-ancestor values keyed by ancestor component id (`ancestor.` prefix). */
  ancestorValues?: Record<string, unknown>;
  /** The current component's own value (`component` / `component.<field>`). */
  componentValue?: unknown;
  /** Host-provided context (`host.` prefix). */
  hostContext?: Record<string, unknown>;
  /** The host's calendar day, `YYYY-MM-DD`; `today()` and `age()` read it. Absent: no clock. */
  today?: string;
  /** Plugin functions by name, taking their arguments only; tried after every built-in. */
  functions?: Record<string, (args: unknown[]) => unknown>;
  /** The 1-based position of the current entry inside a repeating section (`rowIndex()`). */
  rowIndex?: number;
  /** How many entries the current repeating section holds (`rowCount()`). */
  rowCount?: number;
  /**
   * Where a function says what it did not do: a size cap tripped, a plugin's result was
   * dropped. The host decides what a line becomes (a log entry, a console warning) and how
   * often; absent, the evaluator is silent.
   */
  warn?: (message: string) => void;
  /**
   * A plain object the host makes once per runtime or run, where `matches` keeps the patterns it
   * compiled. Absent, every call compiles its pattern; present or not, the results are the same.
   */
  regexCache?: Record<string, unknown>;
}

export function kernelExprReadNested(source: unknown, path: string): unknown {
  if (path.length === 0) {
    return source;
  }
  let cursor = source;
  for (const part of path.split(".")) {
    // Own keys only: a path named `constructor` or `toString` reads an answer, never a member
    // every object inherits.
    if (cursor === null || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Reads `path` from a record whose own keys may themselves hold dots — an entry keyed
 * `address.city`, an enclosing entry filed under its collection path `order.items`:
 * the whole path as a key first, else the longest own key the path starts with and the rest
 * inside it, else nothing. On plain nested objects it reads what {@link kernelExprReadNested} reads.
 */
export function kernelExprReadKeyed(source: unknown, path: string): unknown {
  if (source === null || typeof source !== "object") {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, path)) {
    return record[path];
  }
  // The longest own key the path starts with (followed by a dot) is one of the path's dotted
  // prefixes: try them from the longest down, and read the rest inside the first that is a key.
  // A walk of the path's dots, never of the record's keys, so a wide record costs no more.
  let dot = path.lastIndexOf(".");
  while (dot >= 0) {
    const key = path.slice(0, dot);
    // Own and enumerable, the keys `Object.keys` lists: a hidden member is no key of the record.
    if (Object.prototype.propertyIsEnumerable.call(record, key)) {
      return kernelExprReadKeyed(record[key], path.slice(dot + 1));
    }
    if (dot === 0) {
      break;
    }
    dot = path.lastIndexOf(".", dot - 1);
  }
  return undefined;
}

export function kernelExprReadScopedPath(path: string, context: RuleEvaluationContext): unknown {
  if (path === "component") {
    return context.componentValue;
  }
  if (path.startsWith("component.")) {
    return kernelExprReadNested(context.componentValue, path.slice("component.".length));
  }
  if (path.startsWith("row.")) {
    // An entry's own keys first: a field under a data-scoping container inside the entry is
    // keyed `address.city` in the row the collection reads; then nested.
    return kernelExprReadKeyed(context.rowValues ?? {}, path.slice("row.".length));
  }
  if (path.startsWith("host.")) {
    return kernelExprReadNested(context.hostContext ?? {}, path.slice("host.".length));
  }
  if (path.startsWith("ancestor.")) {
    // An enclosing entry is filed under its collection path, which may hold dots (`order.items`).
    return kernelExprReadKeyed(context.ancestorValues ?? {}, path.slice("ancestor.".length));
  }
  // Form scope: exact key first (supports `foo[0].bar` instance-path keys), then nested.
  if (Object.prototype.hasOwnProperty.call(context.values, path)) {
    return context.values[path];
  }
  return kernelExprReadNested(context.values, path);
}

/**
 * A value as a condition reads it: STRICT, only the boolean `true` holds (a value that merely looks truthy
 * does not pass). `false`, `null`, a missing answer, a number (`1` and `0` alike), a text
 * (`"yes"` and `"false"` alike), a list (an empty one too), an object and a choice group with
 * nothing ticked all fail. A condition that is not a yes-or-no therefore never holds, instead of
 * reading by JavaScript truthiness (a non-empty text held, an empty list held); the compile and
 * the builder warn when a condition's result is provably not a yes-or-no. `and`, `or`, `not` and
 * `if` read their operands through this, and so does every rule verdict site (`visibleWhen`,
 * `requiredWhen`, `enabledWhen`, `readonlyWhen`, `navigationGating`, a journey `when`, a PDF
 * layout `when`) as `=== true`. Note `not x` holds for any `x` that is not `true`.
 */
export function kernelExprAsBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * A value as the number arithmetic reads: a finite number as is, a numeric text (trimmed, not
 * blank) read as a decimal numeral, and `NaN` for everything else, a missing answer, `null`, a
 * blank or non-numeric text, a boolean, a list or an object among them. A decimal numeral is an
 * optional sign, digits with an optional fraction or a fraction with no whole part, and an
 * optional exponent (`12`, `-3.5`, `.5`, `1e3`): the text `0x10`, `0b11`, `Infinity` or
 * `1_000` is not one, so a reference code that looks like a literal in JavaScript is never added
 * up. `NaN` is the reader's "not a number", never a result: {@link kernelExprArithmetic} and the
 * numeric built-ins turn it into no answer (`undefined`, FEEL's null), and the orderings in
 * {@link kernelExprCompare} read it as false. The sum of zero and the reading keeps `-0` out.
 */
export function kernelExprAsNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value + 0 : Number.NaN;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      return Number.NaN;
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed + 0 : Number.NaN;
  }
  return Number.NaN;
}

/**
 * The arguments of `sum`, `min`, `max` and the number group's `avg` as numbers: a list
 * argument contributes its items (`sum(pluck(items, "amount"))`), anything else itself. An
 * item with nothing in it (`kernelExprIsEmpty`: a missing answer, `null`, a blank text) is
 * left out, so a total over a page's optional fields fills once one is answered;
 * an item that is there but is not a number (a text, a boolean, an object) makes the whole
 * aggregate no answer (`undefined`), as DMN FEEL has it, never `NaN`.
 */
export function kernelExprNumbers(args: unknown[]): number[] | undefined {
  const numbers: number[] = [];
  for (const value of args) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (kernelExprIsEmpty(item)) {
        continue;
      }
      const n = kernelExprAsNumber(item);
      if (!Number.isFinite(n)) {
        return undefined;
      }
      numbers.push(n);
    }
  }
  return numbers;
}

/**
 * `eq` and `neq` are strict equality, with one reading: a missing answer (`undefined`) and
 * `null` are the same nothing, so `ratio = null` holds for a calculation that came to no
 * answer and for a field never filled alike, and `ratio != null` means the ratio is known.
 * The orderings compare two texts by UTF-16 code unit (`"apple" < "banana"`, `"abc" <= "abc"`),
 * which orders days written `YYYY-MM-DD` as days, except that two texts that are BOTH decimal
 * numerals by `kernelExprAsNumber` order as numbers (`"10" > "9"`); `"2026-1-5"` is no day but a
 * text. Anything else is read numerically (a number, or a numeric text against a number), so a non-numeric text against a
 * number, a missing answer or a boolean never orders (`NaN`).
 */
export function kernelExprCompare(
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
  left: unknown,
  right: unknown
): boolean {
  if (operator === "eq" || operator === "neq") {
    const same = (left === undefined ? null : left) === (right === undefined ? null : right);
    return operator === "eq" ? same : !same;
  }
  if (typeof left === "string" && typeof right === "string") {
    const leftNumber = kernelExprAsNumber(left);
    const rightNumber = kernelExprAsNumber(right);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
      return kernelExprCompare(operator, leftNumber, rightNumber);
    }
    switch (operator) {
      case "gt":
        return left > right;
      case "gte":
        return left >= right;
      case "lt":
        return left < right;
      case "lte":
        return left <= right;
      default:
        return false;
    }
  }
  switch (operator) {
    case "gt":
      return kernelExprAsNumber(left) > kernelExprAsNumber(right);
    case "gte":
      return kernelExprAsNumber(left) >= kernelExprAsNumber(right);
    case "lt":
      return kernelExprAsNumber(left) < kernelExprAsNumber(right);
    case "lte":
      return kernelExprAsNumber(left) <= kernelExprAsNumber(right);
    default:
      return false;
  }
}

/**
 * `+ - * /` as DMN FEEL has them: an operand that is not a finite number (a missing answer,
 * `null`, a blank or non-numeric text, a boolean) makes the result no answer (`undefined`), as
 * does dividing by zero or a result past the finite range. Never `NaN` or `Infinity`: a
 * calculation that comes to no answer leaves its field empty, on both sides alike.
 */
export function kernelExprArithmetic(
  operator: "add" | "subtract" | "multiply" | "divide",
  left: unknown,
  right: unknown
): number | undefined {
  const a = kernelExprAsNumber(left);
  const b = kernelExprAsNumber(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return undefined;
  }
  let result: number;
  switch (operator) {
    case "add":
      result = a + b;
      break;
    case "subtract":
      result = a - b;
      break;
    case "multiply":
      result = a * b;
      break;
    case "divide":
      if (b === 0) {
        return undefined;
      }
      result = a / b;
      break;
    default:
      return undefined;
  }
  return Number.isFinite(result) ? result + 0 : undefined;
}

/**
 * `abs`, `round`, `floor` and `ceil` over one argument: no answer unless it is a finite
 * number, never `NaN`.
 */
export function kernelExprUnaryNumber(name: "abs" | "round" | "floor" | "ceil", value: unknown): number | undefined {
  const n = kernelExprAsNumber(value);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  // `+ 0` keeps a negative zero (`round(-0.4)`, `ceil(-0.5)`) from being the answer.
  switch (name) {
    case "abs":
      return Math.abs(n) + 0;
    case "round":
      return Math.round(n) + 0;
    case "floor":
      return Math.floor(n) + 0;
    case "ceil":
      return Math.ceil(n) + 0;
    default:
      return undefined;
  }
}

/**
 * `empty(x)`: nothing to read. Missing, `null`, a non-finite number, a text that is blank once
 * trimmed, an empty list, an object with no keys, and a flags object (every value a boolean,
 * a checkbox group's answer) with none ticked. `false` and `0` are answers, so not empty; an
 * object holding anything but flags (an address, a file) is an answer too. Mirrors
 * `kernelIsEmptyValue(value, type)` in the portable kernel, which has the type to hand.
 */
export function kernelExprIsEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    if (entries.length === 0) {
      return true;
    }
    let flags = true;
    let ticked = false;
    for (const entry of entries) {
      if (typeof entry !== "boolean") {
        flags = false;
      } else if (entry) {
        ticked = true;
      }
    }
    return flags && !ticked;
  }
  return false;
}

/**
 * `selected(x)`: the chosen options as a list. A list as is; a flags object's keys whose value
 * is `true`, in insertion order (a checkbox group); a non-empty text on its own (a single
 * choice); anything else an empty list. `count(x)` is its length.
 */
export function kernelExprSelected(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys: unknown[] = [];
    for (const key of Object.keys(record)) {
      if (record[key] === true) {
        keys.push(key);
      }
    }
    return keys;
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

/**
 * Why a plugin function's result is not a plain value, or `undefined` when it is one. A plain
 * value is `undefined`, `null`, a text, a boolean, a finite number, or a list or a plain object
 * (no class instance) of plain values. Everything else would poison a rule: a number that is
 * not finite (`NaN` stored as an answer), a promise (always true), a function, a `Date` or any
 * other class instance (a fresh object on every pass, never settling, not data). The text names
 * the offender for a log line; {@link kernelExprCall} reads a result with a problem as no
 * answer. Walks with an explicit stack, to a depth of 64 (a cycle is deeper).
 */
export function kernelExprPluginProblem(value: unknown): string | undefined {
  const stack: unknown[] = [value];
  const depths: number[] = [0];
  while (stack.length > 0) {
    const item = stack.pop();
    const depth = depths.pop() as number;
    if (item === undefined || item === null) {
      continue;
    }
    const type = typeof item;
    if (type === "string" || type === "boolean") {
      continue;
    }
    if (type === "number") {
      if (!isFinite(item as number)) {
        return "a number that is not finite";
      }
      continue;
    }
    if (type !== "object") {
      return type === "function" ? "a function" : "a " + type;
    }
    if (depth > 64) {
      return "a value nested too deeply";
    }
    const record = item as Record<string, unknown>;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i += 1) {
        stack.push(item[i]);
        depths.push(depth + 1);
      }
      continue;
    }
    if (typeof record.then === "function") {
      return "a promise";
    }
    // A class instance of any kind (a date among them) has a prototype whose own prototype is
    // not the end of the chain; a plain object, from any realm, has the end of it or none.
    const proto = Object.getPrototypeOf(item);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      return "an instance of a class";
    }
    const keys = Object.keys(record);
    for (let i = 0; i < keys.length; i += 1) {
      stack.push(record[keys[i] as string]);
      depths.push(depth + 1);
    }
  }
  return undefined;
}

/**
 * Whether a list or record holds more than `limit` values counted as the tree it expands to:
 * every item at any depth counts once, each time it is reached, so a list that holds the same
 * list twice (`append(prev, prev)` shares structure) counts both copies. The item cap is
 * measured with this, not with the top-level length, or a chain of such calls would be a
 * handful of items that expand to 2^n. Stops counting at the limit,
 * so the walk costs at most `limit` steps whatever the structure, and a value that is not a
 * list or a record is never over.
 */
export function kernelExprExpandedOver(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === null || typeof item !== "object") {
      continue;
    }
    if (Array.isArray(item)) {
      count += item.length;
      if (count > limit) {
        return true;
      }
      for (let i = 0; i < item.length; i += 1) {
        stack.push(item[i]);
      }
      continue;
    }
    const keys = Object.keys(item);
    count += keys.length;
    if (count > limit) {
      return true;
    }
    for (let i = 0; i < keys.length; i += 1) {
      stack.push((item as Record<string, unknown>)[keys[i] as string]);
    }
  }
  return false;
}

/** Says `message` to the context's `warn`, when it has one; never throws. */
export function kernelExprWarn(context: RuleEvaluationContext, message: string): void {
  if (typeof context.warn === "function") {
    try {
      context.warn(message);
    } catch {
      // A sink that fails is no reason to fail a rule.
    }
  }
}

/**
 * Whether `name` is a list function handed a list over the item cap ({@link kernelMaxFormulaListItems});
 * if so, says so once through the context's `warn` ("<name>: the list is over the 10,000 item
 * cap; no answer") and the caller gives `undefined`. A function that is not a list function, or a
 * plugin function, is never refused here.
 */
export function kernelExprListTooLong(name: string, args: unknown[], context: RuleEvaluationContext): boolean {
  // The common call has no list among its arguments, or none over the cap: look at the
  // arguments first, and only then ask whether the function is one that refuses it.
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (Array.isArray(item) && item.length > kernelMaxFormulaListItems()) {
      const listFunctions = ",sum,min,max,avg,count,contains,indexOf,first,last,distinct,sort,reverse,append,pluck,any,all,join,split,";
      if (listFunctions.indexOf("," + name + ",") < 0) {
        return false;
      }
      kernelExprWarn(context, name + ": the list is over the " + kernelMaxFormulaListItems() + " item cap; no answer");
      return true;
    }
  }
  return false;
}

/**
 * Evaluates a function call over its evaluated arguments: the built-ins this switch holds, then
 * the library's groups, then the host's plugin functions (`context.functions`, own properties
 * only; a throw yields `undefined`, and so does a result that is not a plain value, see
 * {@link kernelExprPluginProblem}). The kernel never dies for a function: the whole dispatch is
 * guarded, so a bug anywhere in it, an argument too large for the stack among them, is
 * `undefined` with a line to `context.warn`, never a throw out of the run. A name none of them
 * knows yields `undefined`. The context-aware calls (`today`, `age`, `rowIndex`, `rowCount`)
 * never reach this: the evaluator handles them from the context before calling here, so a
 * plugin cannot shadow them, nor any other built-in.
 */
export function kernelExprCall(name: string, args: unknown[], context: RuleEvaluationContext): unknown {
  try {
    if (kernelExprListTooLong(name, args, context)) {
      return undefined;
    }
    const result = kernelExprDispatch(name, args, context);
    // A split can make more pieces than the text has characters' worth of cap allows (10,000
    // separators make 10,001), and an append can hold a list twice over; any result is held to
    // the same item cap as an input list, counted as the tree it expands to.
    if (typeof result === "object" && result !== null && kernelExprExpandedOver(result, kernelMaxFormulaListItems())) {
      kernelExprWarn(context, name + ": the result is over the " + kernelMaxFormulaListItems() + " item cap; no answer");
      return undefined;
    }
    return result;
  } catch (failure) {
    kernelExprWarn(context, name + ": the call failed (" + (failure instanceof Error ? failure.message : String(failure)) + "); no answer");
    return undefined;
  }
}

/** The dispatch {@link kernelExprCall} guards. */
export function kernelExprDispatch(name: string, args: unknown[], context: RuleEvaluationContext): unknown {
  switch (name) {
    case "sum": {
      // Nothing to add is 0; an item that is there but is not a number makes the sum no answer.
      const numbers = kernelExprNumbers(args);
      if (numbers === undefined) {
        return undefined;
      }
      let total = 0;
      for (let i = 0; i < numbers.length; i += 1) {
        total += numbers[i] as number;
      }
      return Number.isFinite(total) ? total + 0 : undefined;
    }
    case "min":
    case "max": {
      // A loop, not `Math.min(...numbers)`: a long list spread onto the stack throws.
      const numbers = kernelExprNumbers(args);
      if (numbers === undefined || numbers.length === 0) {
        return undefined;
      }
      let best = numbers[0] as number;
      for (let i = 1; i < numbers.length; i += 1) {
        const n = numbers[i] as number;
        if (name === "min" ? n < best : n > best) {
          best = n;
        }
      }
      return best + 0;
    }
    case "len": {
      // Characters are code points: an emoji is one. A list is its item count.
      const value = args[0];
      if (Array.isArray(value)) {
        return value.length;
      }
      const text = kernelTextArg(value);
      return text === undefined ? undefined : kernelTextLength(text);
    }
    case "round":
    case "floor":
    case "ceil":
    case "abs":
      return kernelExprUnaryNumber(name, args[0]);
    case "coalesce":
      return args.find((value) => value !== null && value !== undefined);
    case "concat": {
      // A missing value adds nothing; a list or an object has no text, so the result has none.
      let joined = "";
      for (let i = 0; i < args.length; i += 1) {
        const value = args[i];
        if (value === null || value === undefined) {
          continue;
        }
        const piece = kernelTextArg(value);
        if (piece === undefined) {
          return undefined;
        }
        joined += piece;
        if (joined.length > 10000) {
          // The rest cannot show in the first 10,000: stop reading arguments.
          kernelExprWarn(context, "concat: the text is over the 10,000 character cap; its first 10,000 characters were used (text.truncated)");
          return kernelTextHead(joined);
        }
      }
      return joined;
    }
    case "lower":
    case "upper": {
      const whole = kernelTextArg(args[0]);
      if (whole === undefined) {
        return undefined;
      }
      const text = kernelTextOverCap(whole, context.warn, name) ? kernelTextHead(whole) : whole;
      return name === "lower" ? text.toLowerCase() : text.toUpperCase();
    }
    case "contains": {
      // A needle that is not a text, a number or a boolean has nothing to look for; a haystack
      // that is neither a text nor a list has nothing to look in: no answer, not false.
      const haystack = args[0];
      const needle = args[1];
      if (needle === null || needle === undefined || typeof needle === "object" || typeof needle === "function") {
        return undefined;
      }
      if (typeof haystack === "string") {
        const read = kernelTextOverCap(haystack, context.warn, name) ? kernelTextHead(haystack) : haystack;
        const piece = kernelTextArg(needle);
        return piece === undefined ? undefined : read.includes(piece);
      }
      if (Array.isArray(haystack)) {
        return haystack.includes(needle);
      }
      return undefined;
    }
    case "empty":
      return kernelExprIsEmpty(args[0]);
    case "selected":
      return kernelExprSelected(args[0]);
    case "count":
      return kernelExprSelected(args[0]).length;
    default:
      break;
  }
  const warn = context.warn;
  if (kernelTextHandles(name)) {
    return kernelTextCall(name, args, warn, context.regexCache);
  }
  if (kernelNumberHandles(name)) {
    return kernelNumberCall(name, args);
  }
  if (kernelListHandles(name)) {
    return kernelListCall(name, args);
  }
  if (kernelDateHandles(name)) {
    return kernelDateCall(name, args);
  }
  const functions = context.functions;
  if (functions !== undefined && Object.prototype.hasOwnProperty.call(functions, name)) {
    const plugin = functions[name];
    if (typeof plugin === "function") {
      try {
        const result = plugin(args);
        const problem = kernelExprPluginProblem(result);
        if (problem !== undefined) {
          // The host's wrapper has usually said so already; this is the line for a host without one.
          kernelExprWarn(context, 'the function "' + name + '" returned ' + problem + "; read as no answer");
          return undefined;
        }
        return result;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * One operator of a binary, logical or arithmetic node applied to the value of its left side:
 * the right operand is evaluated here, and only when the operator reads it (`and` stops at a
 * left that does not hold, `or` at one that does).
 */
export function kernelExprStep(node: Expression, left: unknown, context: RuleEvaluationContext): unknown {
  if (node.kind === "logical") {
    const held = kernelExprAsBoolean(left);
    if (node.operator === "and") {
      return held && kernelExprAsBoolean(kernelEvaluateExpression(node.right, context));
    }
    return held || kernelExprAsBoolean(kernelEvaluateExpression(node.right, context));
  }
  if (node.kind === "binary") {
    return kernelExprCompare(node.operator, left, kernelEvaluateExpression(node.right, context));
  }
  if (node.kind === "arithmetic") {
    return kernelExprArithmetic(node.operator, left, kernelEvaluateExpression(node.right, context));
  }
  return left;
}

/** The evaluator under its kernel name: what the sandbox program calls. */
export function kernelEvaluateExpression(
  expression: Expression,
  context: RuleEvaluationContext
): unknown {
  switch (expression.kind) {
    case "literal":
      return expression.value;

    case "path":
      return kernelExprReadScopedPath(expression.path, context);

    case "unary":
      if (expression.operator === "not") {
        return !kernelExprAsBoolean(kernelEvaluateExpression(expression.operand, context));
      }
      return false;

    case "binary":
    case "logical":
    case "arithmetic": {
      // A chain `a and b and c ...` (or `+`, `=`, a mix) is a tree leaning left, as deep as it is
      // long; recursing down it overflows the sandbox's stack (1 MiB) near two thousand terms.
      // So walk the left spine into a list and fold it back up, evaluating each right operand
      // in order: the same reading, left to right, short-circuit and all. Only true nesting
      // (parentheses, arguments), which the parser bounds, recurses.
      const first = expression.left;
      if (first.kind !== "binary" && first.kind !== "logical" && first.kind !== "arithmetic") {
        // One operator over two operands, the common rule: no spine to collect.
        return kernelExprStep(expression, kernelEvaluateExpression(first, context), context);
      }
      const spine: Expression[] = [];
      let leftmost: Expression = expression;
      while (leftmost.kind === "binary" || leftmost.kind === "logical" || leftmost.kind === "arithmetic") {
        spine.push(leftmost);
        leftmost = leftmost.left;
      }
      let result: unknown = kernelEvaluateExpression(leftmost, context);
      for (let i = spine.length - 1; i >= 0; i -= 1) {
        result = kernelExprStep(spine[i] as Expression, result, context);
      }
      return result;
    }

    case "call": {
      // The context-aware calls read the context, not only their arguments, so they are
      // answered here and never reach a function group or a plugin.
      if (expression.name === "today") {
        return context.today !== undefined && kernelIsDateAnswer(context.today) ? context.today : undefined;
      }
      if (expression.name === "rowIndex") {
        return context.rowIndex;
      }
      if (expression.name === "rowCount") {
        return context.rowCount;
      }
      if (expression.name === "age") {
        const first = expression.args[0];
        const birth = first === undefined ? undefined : kernelEvaluateExpression(first, context);
        const today = context.today;
        if (!kernelIsDateAnswer(birth) || today === undefined || !kernelIsDateAnswer(today)) {
          return undefined;
        }
        // Whole years so far; a birth date after the day is not yet an age: no answer.
        const years = kernelDateCall("dateDiff", [birth, today, "years"]);
        return typeof years === "number" && years < 0 ? undefined : years;
      }
      const argNodes = expression.args;
      const values: unknown[] = [];
      for (let i = 0; i < argNodes.length; i += 1) {
        values.push(kernelEvaluateExpression(argNodes[i] as Expression, context));
      }
      return kernelExprCall(expression.name, values, context);
    }

    case "if": {
      for (const entry of expression.cases) {
        if (kernelExprAsBoolean(kernelEvaluateExpression(entry.when, context))) {
          return kernelEvaluateExpression(entry.then, context);
        }
      }
      return expression.else === undefined ? undefined : kernelEvaluateExpression(expression.else, context);
    }

    default:
      return undefined;
  }
}

/**
 * Whether `expression` reads a `host.` path anywhere in it. A server re-validating a submission
 * has no host context, so the kernel leaves a rule that reads one unevaluated.
 * Walks with an explicit stack: a long chain is a deep tree.
 */
export function kernelExprReadsHost(expression: Expression): boolean {
  const stack: Expression[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop() as Expression;
    switch (node.kind) {
      case "path":
        if (node.path.startsWith("host.")) {
          return true;
        }
        break;
      case "unary":
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic":
        stack.push(node.left, node.right);
        break;
      case "call":
        for (const arg of node.args) {
          stack.push(arg);
        }
        break;
      case "if":
        for (const entry of node.cases) {
          stack.push(entry.when, entry.then);
        }
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * Whether `expression` reads the day anywhere in it: a `today()` or an `age()` call, in any
 * branch. A side with no `context.today` treats such a rule as it treats a `host.` read, and
 * a submission outcome lists the components whose rules did (`clockDependent`). Explicit stack.
 */
export function kernelExprReadsClock(expression: Expression): boolean {
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
        stack.push(node.left, node.right);
        break;
      case "call":
        if (node.name === "today" || node.name === "age") {
          return true;
        }
        for (const arg of node.args) {
          stack.push(arg);
        }
        break;
      case "if":
        for (const entry of node.cases) {
          stack.push(entry.when, entry.then);
        }
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        break;
      default:
        break;
    }
  }
  return false;
}

/**
 * Every path `expression` reads, in reading order, repeats kept — both sides of an `and` or an
 * `or`, every branch of an `if`, whether or not evaluation would reach it. A server recomputing
 * a calculation reads its inputs through this: one it was not sent means the browser's result
 * cannot be reproduced. Explicit stack, children pushed in reverse so the first
 * is read first; linear in the tree however it leans.
 */
export function kernelExprReadPaths(expression: Expression): string[] {
  const paths: string[] = [];
  const stack: Expression[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop() as Expression;
    switch (node.kind) {
      case "path":
        paths.push(node.path);
        break;
      case "unary":
        stack.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic":
        stack.push(node.right, node.left);
        break;
      case "call":
        for (let i = node.args.length - 1; i >= 0; i -= 1) {
          stack.push(node.args[i] as Expression);
        }
        break;
      case "if": {
        if (node.else !== undefined) {
          stack.push(node.else);
        }
        for (let i = node.cases.length - 1; i >= 0; i -= 1) {
          const entry = node.cases[i] as { when: Expression; then: Expression };
          stack.push(entry.then, entry.when);
        }
        break;
      }
      default:
        break;
    }
  }
  return paths;
}

/** Evaluates `expression` against `context`: the evaluator's public name. */
export function evaluateExpression(
  expression: Expression,
  context: RuleEvaluationContext
): unknown {
  return kernelEvaluateExpression(expression, context);
}

/**
 * For the sandbox program to splice in beside the kernel's (`PORTABLE_KERNEL_FUNCTIONS`):
 * every kernel-named function above. {@link evaluateExpression} is left out — nothing in the
 * sandbox calls it.
 */
export const EXPRESSION_EVALUATOR_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelExprReadNested,
  kernelExprReadKeyed,
  kernelExprReadScopedPath,
  kernelExprAsBoolean,
  kernelExprAsNumber,
  kernelExprNumbers,
  kernelExprCompare,
  kernelExprArithmetic,
  kernelExprUnaryNumber,
  kernelExprIsEmpty,
  kernelExprSelected,
  kernelExprPluginProblem,
  kernelExprExpandedOver,
  kernelExprWarn,
  kernelExprListTooLong,
  kernelExprCall,
  kernelExprDispatch,
  kernelExprStep,
  kernelEvaluateExpression,
  kernelExprReadsHost,
  kernelExprReadsClock,
  kernelExprReadPaths
];
