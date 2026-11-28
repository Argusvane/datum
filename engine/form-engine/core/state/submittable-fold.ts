import type { ComponentNode } from "../schema/types.js";
import type { Journey } from "../schema/journey.js";
import type {
  JourneyOwnership,
  JourneyPathInput,
  JourneyPlacement,
  JourneyTrace
} from "../journey/journey-types.js";
import { kernelExprReadsClock, kernelExprReadsHost } from "../../rules/evaluator/evaluator.js";
import { kernelIsExpressionTree, kernelIsRuleObject, kernelMaxComponentDepth, kernelRuleExpression, kernelRuleRunsOn, kernelTreeReadsRow } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { Expression } from "../expressions/expression.js";
import type { FormulaFunctionSignature } from "../expressions/formula-types.js";
import {
  computeEffectiveNodeState,
  type EffectiveNodeState,
  type HiddenValueBehavior,
  type SemanticNodeState
} from "./effective-state.js";
import { kernelReadEnum, kernelReadFlag } from "./semantic-state.js";

/**
 * The fold from answers to what is shown, validated and submitted — one function
 * the browser runtime and the validation sandbox both run, so a server re-validating a
 * submission sees exactly what the person's browser did.
 *
 * The rule it keeps: **every rule and every journey decision reads the submittable view** —
 * the answers as they would be submitted, with hidden-and-excluded values gone. A server only
 * ever receives that view, so a browser that let a rule read an excluded answer could decide
 * something no server can reproduce. The fold therefore iterates: resolve every node's rules
 * over the current view, fold ancestors, place components against the journey's path, apply
 * the hidden-value policy to the raw answers, and go again over the new view until it stops
 * changing. The server starts from the fixpoint (what was submitted) and lands on it at once.
 *
 * Once the view has settled, the fold works out each component's **requiredness** over it: `configuration.required`, or its `rules.requiredWhen` holding over that same
 * view — the rule adds to the tick, never removes it. The rule is read only for a component
 * that holds an answer of its own ({@link kernelFoldHoldsOwnAnswer}) and sits in no repeating
 * section ({@link kernelFoldInSection}); everything else keeps its tick. Both sides run this
 * too, so a field the browser marks required is one every server holds to. Beside it, and read
 * on the same components over the same view, each `rules.validWhen`: the components
 * whose check does not hold are listed in `invalid`, for the field-constraints check of either
 * side to refuse a non-empty answer with `rule`.
 *
 * **Form rules always hold.** A journey (one page or many) is another way to
 * fill the form, never a way to relax it. A form field the journey places on no page is folded
 * exactly as the whole form folds it — its own visibility, its own Required, its own value
 * behaviour ({@link kernelPlacedSemanticState}) — so no client can name a journey to skip a
 * required field the journey leaves off every page, nor that field's plugin and custom checks.
 * Fields on pages the path skips keep the structure rule (structure the server replays). One
 * exception, decided from the definition alone so both sides make it: a field on no page whose
 * own `visibleWhen`, or any ancestor's, reads `host.` ({@link kernelFoldVisibilityReadsHost})
 * keeps the earlier lenient fold — hidden, not validated, not required, its answer by its own
 * value behaviour — on both sides. The server has no host context to replay that visibility
 * with, and the browser, where the field is on no screen, would otherwise refuse or accept by
 * the host what a server judges the other way; agreeing on leniency is the lesser evil. For the
 * same reason a field on no page whose own `requiredWhen` reads `host.`
 * ({@link kernelFoldRequiredReadsHost}) keeps its tick alone on both sides: the kernel never
 * reads such a rule, and a browser that did would refuse, on a field no page shows, what the
 * server accepts. The journey diagnostics name both (`component.unassigned` as a warning,
 * `rule.reads-host`).
 *
 * **Formulas and run scopes.** The fold reads a compiled definition: every formula replaced
 * by its tree (`kernelCompileDefinition`, `core/expressions/compile.ts`), each rule a tree or
 * the object form `{ expression, run }`, read through {@link kernelCompiledRule}. A rule's
 * `run` says which side applies it ({@link kernelRuleSkipped}): the server skips a
 * `browser`-only rule exactly as it skips one reading `host.`, and the browser ignores a
 * `server` or `server-secret` one. A rule reading the clock (`today()`, `age()`) on a side
 * that was given no day is skipped the same way.
 *
 * Written the validation kernel's way: top-level `function` declarations, type-only
 * imports apart from functions that are themselves spliced into the sandbox program
 * (`computeEffectiveNodeState`, `kernelReadFlag`, `kernelExprReadsHost`, `kernelExprReadsClock`,
 * the compile module's rule readers), no module constants, plain records.
 * {@link SUBMITTABLE_FOLD_FUNCTIONS} lists this module's functions.
 *
 * **The path engine is input.** The fold imports no journey path engine: a caller
 * with a journey hands it `journeyPath` and `journeyPlacements` ({@link KernelFoldJourney.path},
 * {@link KernelFoldJourney.place}) beside the ownership and the condition evaluator, as the
 * kernel does with the functions the sandbox program splices in. So a form without a journey
 * loads no path engine to fold, and both sides still run one path engine.
 *
 * The records are keyed by component ids and submitted value keys, so a key such as
 * `constructor`, `toString` or `__proto__` must behave like any other: an unknown one kept by
 * the sandbox's `"keep"` mode is an answer like the rest. The records the fold builds have no
 * prototype (`Object.create(null)`), and it reads the ones handed to it — the runtime builds
 * its own as ordinary objects — through {@link kernelOwn}.
 *
 * **The answers are read as the envelope carries them (JSON semantics).** A server only ever
 * holds the answers as JSON, so the fold starts from {@link kernelJsonAnswers}: a non-finite
 * number (a calculation that divided by an empty or zero answer) reads as `null`, `-0` as `0`,
 * and an entry holding `undefined` is absent. Its submittable view is therefore what the
 * envelope carries, in the browser as on the server. And the rules and the journey read only
 * the keys the schema defines ({@link KernelFoldInput.defines}): a key no component owns is not
 * on every server (the sandbox strips it by default), so no rule and no journey reads it. A
 * calculation can (calculations are worked out before the fold, over every key), and its result
 * is an answer like any other; both sides agree on it.
 */

export interface KernelFoldJourney {
  journey: Journey;
  ownership: JourneyOwnership;
  /**
   * The path engine's walk: `journeyPath` (`core/journey/journey-path.ts`), handed in rather
   * than imported. The browser passes the module's function, the kernel the one the
   * sandbox program splices in; nothing else is ever passed.
   */
  path: (journey: Journey, input: JourneyPathInput) => JourneyTrace;
  /** Where each component stands against the path: `journeyPlacements`, handed in the same way. */
  place: (ownership: JourneyOwnership, trace: JourneyTrace) => Record<string, JourneyPlacement>;
  /**
   * Evaluates a route's condition over component-id-keyed values, with the day
   * the fold was given ({@link KernelFoldInput.today}) as its third argument, so a condition
   * on `today()` reads the same day as every rule of the same recompute.
   */
  evaluate: (expression: Expression, values: Record<string, unknown>, today?: string) => unknown;
}

export interface KernelFoldInput {
  /** Every node id, root first, in document (pre-)order. */
  order: string[];
  nodeById: Record<string, ComponentNode>;
  /** Child id -> parent id. */
  parentOf: Record<string, string>;
  /** The answers as stored: keyed by value path. */
  values: Record<string, unknown>;
  /** Component id -> the value path its answer is stored at (absent: the id itself). */
  pathOf: Record<string, string>;
  /** Value path -> the ids of the components stored there, in document order. */
  idsByPath: Record<string, string[]>;
  /**
   * Collection path -> the repeating section whose entries live there (its
   * `collection.collectionPath` as written, else its id). An entry's keys (`order_lines[0].sku`)
   * belong to no component, and a collection path of its own shares no leading segment with the
   * section, so without this they would pass the hidden-value policy whatever the section's
   * state. Not for re-keying rule values: `idsByPath` does that.
   */
  collectionOwners?: Record<string, string>;
  /**
   * A node's own semantic state — its configuration flags and its `visibleWhen` /
   * `enabledWhen` / `readonlyWhen` rules — over the current view (keyed both ways).
   */
  resolve: (
    node: ComponentNode,
    idValues: Record<string, unknown>,
    pathValues: Record<string, unknown>
  ) => SemanticNodeState;
  /** The active journey, when there is one: its path folds everything off it to hidden. */
  journey?: KernelFoldJourney;
  /**
   * Whether the schema defines a value key — the sandbox's allowlist
   * (`kernelDefinesKey` over `kernelKnownKeyShapes`, `validation/wasm/portable-kernel.ts`). The
   * rules and the journey read only such keys; every other key still passes through to the
   * submittable answers, for the caller's unknown-field policy to decide. Absent: every key.
   * The browser runtime and the kernel both pass it, so neither reads a key the other lacks.
   */
  defines?: (key: string) => boolean;
  /**
   * Whether `node`'s `rules.requiredWhen` holds over the settled view, keyed both ways. Called once per component the fold reads the rule for, after the view has
   * settled — never for a component without the rule, one holding no answer of its own, or one
   * inside a repeating section. Absent: only `configuration.required` counts. The kernel's
   * answers `false` for a rule reading `host.`, which a server cannot evaluate.
   */
  ruleRequired?: (
    node: ComponentNode,
    idValues: Record<string, unknown>,
    pathValues: Record<string, unknown>
  ) => boolean;
  /**
   * Whether `node`'s `rules.validWhen` holds over the settled view, keyed both ways.
   * Called where {@link ruleRequired} would be — once per component with the rule that holds an
   * answer of its own and sits in no repeating section — after the view has settled. Absent: no
   * component is refused by its rule. A side that cannot evaluate the rule (the kernel, for one
   * reading `host.`) answers `true`: it holds.
   */
  ruleValid?: (
    node: ComponentNode,
    idValues: Record<string, unknown>,
    pathValues: Record<string, unknown>
  ) => boolean;
  /**
   * What a data grid's `rules.minRows` or `rules.maxRows` (`key`) comes to over the settled view,
   * keyed both ways: the value as evaluated, a number or not, `undefined` for a rule
   * this side does not run or that failed. Called once per grid and key the fold reads the rule
   * for ({@link kernelFoldRowBounds}): never for a rule reading `row.`, nor on a component that
   * is not a grid. Absent: no bound formula is read, and the result has no `rowBounds`.
   */
  ruleRowBound?: (
    node: ComponentNode,
    key: "minRows" | "maxRows",
    idValues: Record<string, unknown>,
    pathValues: Record<string, unknown>
  ) => unknown;
  /**
   * The calendar day this side evaluates with (`YYYY-MM-DD`): the browser's snapshot for the
   * recompute, the server's `context.today`. Handed to the journey's `evaluate`, and read where
   * the fold decides whether a rule can be replayed: absent, a rule reading the clock cannot be,
   * as one reading `host.` cannot ({@link kernelRuleSkipped}).
   */
  today?: string;
}

export interface KernelFoldResult {
  /** Each node's own semantic state, journey placement folded in. */
  semantic: Record<string, SemanticNodeState>;
  effective: Record<string, EffectiveNodeState>;
  /** The submittable answers, keyed by value path, as the envelope carries them. */
  submittable: Record<string, unknown>;
  /**
   * What rules read, keyed by component id: the submittable answers under the keys the schema
   * defines, none holding `undefined`.
   */
  idValues: Record<string, unknown>;
  /**
   * Each component's requiredness over the settled view, before the hidden-required policy: `configuration.required`, or `rules.requiredWhen` holding where the fold reads
   * it ({@link kernelFoldRequired}). Every node but the root, in document order; no prototype.
   * The hidden policy (`requiredApplies`) is the reader's to apply, as for the static flag.
   */
  required: Record<string, boolean>;
  /**
   * The components whose `rules.validWhen` does not hold over the settled view, where
   * the fold reads the rule ({@link kernelFoldInvalid}): id -> `true`, in document order, no
   * prototype, nothing else listed. Whether the answer is empty, and so whether `rule` is
   * raised, is the field-constraints check's to decide, on both sides.
   */
  invalid: Record<string, boolean>;
  /**
   * What each data grid's bound formulas came to over the settled view
   * ({@link kernelFoldRowBounds}): grid id -> `{ min?, max? }`, the values as evaluated, for
   * `resolveDataGridRowBounds` (`core/schema/data-grid.ts`) or the kernel's mirror to weigh against
   * the fixed bounds. Present only when the input has `ruleRowBound` and some grid carries such a
   * rule.
   */
  rowBounds?: Record<string, { min?: unknown; max?: unknown }>;
  /** The journey's path, when there is a journey. */
  trace?: JourneyTrace;
  placements?: Record<string, JourneyPlacement>;
  /** False when the fold hit its pass limit (rules that feed each other through hidden answers). */
  converged: boolean;
  passes: number;
}

/**
 * A record with no prototype whose shape is its own: the dictionaries the kernel builds from
 * submitted keys. QuickJS gives records built with the same sequence of new keys one shared
 * shape chain, and inserting a second dictionary's worth of the same ten thousand keys is
 * quadratic; a unique non-enumerable symbol first makes each record's chain its own. The symbol is invisible to `Object.keys`, spread, `JSON` and `in`-free
 * reads, so no output byte changes.
 */
export function kernelRecord(): any {
  const record = Object.create(null);
  Object.defineProperty(record, Symbol(), { value: 0, enumerable: false });
  return record;
}

/**
 * `record[key]` when the record holds `key` itself, else `undefined`: never an inherited member
 * such as `Object.prototype.constructor`.
 */
export function kernelOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * A value as JSON carries it: a non-finite number is `null` and `-0` is `0`; inside a list an
 * `undefined` item is `null`, inside a record an `undefined` entry is left out; everything
 * else as it is. What comes back is `value` itself unless something in it changed, so a
 * record or list with nothing to change (a file's record, an entry of a section) keeps its
 * identity. A record that changed is rebuilt as an ordinary object from its entries, as
 * `JSON.parse` builds one, so an own `__proto__` key stays a key.
 */
export function kernelJsonValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let items: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      const next = item === undefined ? null : kernelJsonValue(item);
      if (items === undefined && !Object.is(next, item)) {
        items = value.slice(0, index);
      }
      if (items !== undefined) {
        items.push(next);
      }
    }
    return items ?? value;
  }
  const record = value as Record<string, unknown>;
  const entries: Array<[string, unknown]> = [];
  let changed = false;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (item === undefined) {
      changed = true;
      continue;
    }
    const next = kernelJsonValue(item);
    if (!Object.is(next, item)) {
      changed = true;
    }
    entries.push([key, next]);
  }
  return changed ? Object.fromEntries(entries) : value;
}

/**
 * The answers as the envelope carries them ({@link kernelJsonValue} for each): what a server
 * reads once the submission has crossed the wire as JSON, and so what the fold, the rules, the
 * journey and a PDF layout's `when` read on both sides. An entry holding `undefined` is absent.
 */
export function kernelJsonAnswers(values: Record<string, unknown>): Record<string, unknown> {
  const out = kernelRecord() as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value !== undefined) {
      out[key] = kernelJsonValue(value);
    }
  }
  return out;
}

/**
 * What the rules and the journey read of a view: the keys the schema defines (all of them when
 * `defines` is absent), and none holding `undefined` — a cleared answer reads as absent, as
 * the envelope leaves it out.
 */
export function kernelFoldRuleView(
  values: Record<string, unknown>,
  defines: ((key: string) => boolean) | undefined
): Record<string, unknown> {
  const out = kernelRecord() as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value !== undefined && (defines === undefined || defines(key))) {
      out[key] = value;
    }
  }
  return out;
}

/** The segment of a value key before any `.` or `[`. */
export function kernelFoldLeadingSegment(key: string): string {
  let end = key.length;
  const dot = key.indexOf(".");
  const bracket = key.indexOf("[");
  if (dot >= 0 && dot < end) {
    end = dot;
  }
  if (bracket >= 0 && bracket < end) {
    end = bracket;
  }
  return key.slice(0, end);
}

/**
 * The repeating section whose entries a value key belongs to: the key itself as a collection
 * path (the entries as one list), else the part before its first `[` (one entry's field,
 * `order.items[0].sku` -> `order.items`). `undefined` when neither is a collection path.
 */
export function kernelFoldCollectionOwner(collectionOwners: Record<string, string> | undefined, key: string): string | undefined {
  if (collectionOwners === undefined) {
    return undefined;
  }
  const whole = kernelOwn(collectionOwners, key);
  if (whole !== undefined) {
    return whole;
  }
  const bracket = key.indexOf("[");
  return bracket > 0 ? kernelOwn(collectionOwners, key.slice(0, bracket)) : undefined;
}

/**
 * Path-keyed answers re-keyed by component id, for rules: keys no component owns (rows, host
 * extras) pass through first, then each owned value is laid over under every owner's id.
 * The same reading as `valuesByComponentId` (`core/tree/data-scope.ts`).
 */
export function kernelRekeyById(
  values: Record<string, unknown>,
  idsByPath: Record<string, string[]>
): Record<string, unknown> {
  const out = kernelRecord() as Record<string, unknown>;
  const owned: Array<[string[], unknown]> = [];
  for (const key of Object.keys(values)) {
    const ids = kernelOwn(idsByPath, key);
    if (ids !== undefined && ids.length > 0) {
      owned.push([ids, values[key]]);
    } else {
      out[key] = values[key];
    }
  }
  for (const [ids, value] of owned) {
    for (const id of ids) {
      out[id] = value;
    }
  }
  return out;
}

/**
 * The hidden-value policy over path-keyed answers: an excluded answer is dropped, a cleared one
 * kept as `undefined`, the rest pass through. A key is judged by its owning component, else by
 * the key itself as an id, else — an entry of a repeating section — by the section whose
 * collection path holds it, else by its leading segment. `applyHiddenValuePolicy`'s reading,
 * with the collection owners it is given alongside. With a `report`, it sets `report.changed`
 * when it dropped or cleared an answer; left alone, the result holds every key of `values` as
 * it was.
 */
export function kernelApplyValuePolicy(
  values: Record<string, unknown>,
  effective: Record<string, EffectiveNodeState>,
  idsByPath: Record<string, string[]>,
  collectionOwners?: Record<string, string>,
  report?: { changed: boolean }
): Record<string, unknown> {
  const out = kernelRecord() as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    const owners = kernelOwn(idsByPath, key);
    const ownerId = owners !== undefined && owners.length > 0 ? owners[0] : undefined;
    const sectionId = kernelFoldCollectionOwner(collectionOwners, key);
    const state =
      (ownerId !== undefined ? kernelOwn(effective, ownerId) : undefined) ??
      kernelOwn(effective, key) ??
      (sectionId !== undefined ? kernelOwn(effective, sectionId) : undefined) ??
      kernelOwn(effective, kernelFoldLeadingSegment(key));
    if (state === undefined) {
      out[key] = values[key];
      continue;
    }
    if (!state.submitValue) {
      if (report !== undefined) {
        report.changed = true;
      }
      continue;
    }
    if (state.clearValue) {
      if (report !== undefined) {
        report.changed = true;
      }
      out[key] = undefined;
    } else {
      out[key] = values[key];
    }
  }
  return out;
}

/** Each node's effective state: its own semantic state folded with its ancestors'. */
export function kernelFoldEffective(
  order: string[],
  parentOf: Record<string, string>,
  semantic: Record<string, SemanticNodeState>
): Record<string, EffectiveNodeState> {
  const effective = kernelRecord() as Record<string, EffectiveNodeState>;
  for (const id of order) {
    const own = kernelOwn(semantic, id);
    if (own === undefined) {
      continue;
    }
    const chain: SemanticNodeState[] = [];
    // No component sits deeper than the depth cap, so no honest chain is longer; the bound
    // keeps a parent map that loops from walking for ever.
    let parent = kernelOwn(parentOf, id);
    for (let step = 1; parent !== undefined && step < kernelMaxComponentDepth(); step += 1) {
      const state = kernelOwn(semantic, parent);
      if (state !== undefined) {
        chain.push(state);
      }
      parent = kernelOwn(parentOf, parent);
    }
    effective[id] = computeEffectiveNodeState(own, chain);
  }
  return effective;
}

/**
 * The tree a rule holds once the definition is compiled: a tree as it is, or the object form's
 * `expression`. A formula string is no rule here: every runtime compiles its definition before
 * it reads a rule (`kernelCompileDefinition`), replacing each formula by its tree and dropping
 * one that does not parse, so a string that still reaches a reader reads as no rule, which is
 * what an unparseable formula reads as under every policy. The compile module's readers decide
 * the shapes (`kernelIsExpressionTree`, `kernelIsRuleObject`); `journeyRuleTree` is the path
 * engine's pinned copy of this reading.
 */
export function kernelCompiledRule(source: unknown): Expression | undefined {
  if (kernelIsExpressionTree(source)) {
    return source;
  }
  if (kernelIsRuleObject(source) && kernelIsExpressionTree(source.expression)) {
    return source.expression;
  }
  return undefined;
}

/**
 * Whether `side` leaves the rule under `key` unevaluated, the node keeping its configured
 * state for it: the rule's `run` does not name this side (`kernelRuleRunsOn`); or, on the
 * server, it reads a `host.` path (the server has no host context); or it reads the
 * clock (`today()`, `age()`) and this side was given no day. For a
 * rule reading `host.`: a server that cannot evaluate a rule is never stricter than the browser
 * that can, so it skips the rule. A `run` of `server` or `server-secret` is the author opting
 * out of that reading for one rule: the browser ignores it and the server applies it. A
 * `browser` rule is the author saying the server need not replay it.
 *
 * `hostKnown` is true when the server's run was given a host context of its own
 * (`context.hostContext`): it then evaluates a rule reading `host.` against that context like
 * any other, a key the context lacks reading as no answer. Absent or false, such a rule is
 * skipped as above.
 */
export function kernelRuleSkipped(
  source: unknown,
  expression: Expression,
  key: string,
  side: "browser" | "server",
  today: string | undefined,
  hostKnown?: boolean
): boolean {
  if (!kernelRuleRunsOn(source, key, side)) {
    return true;
  }
  if (side === "server" && hostKnown !== true && kernelExprReadsHost(expression)) {
    return true;
  }
  return today === undefined && kernelExprReadsClock(expression);
}

/**
 * Whether the server cannot replay the rule under `key` as the browser applies it, decided
 * from the definition (and the day): it reads `host.`, or its `run` keeps it from the server
 * (`browser`), or it reads the clock and no day was given. A `server` or `server-secret` rule
 * is not such a rule: the browser leaves it alone by design, and the server applies it. What
 * {@link kernelFoldVisibilityReadsHost} and {@link kernelFoldRequiredReadsHost} read. The rule
 * is read through the compile module's reader (`kernelRuleExpression`), so a formula still
 * text (a caller holding the author's definition, as the journey diagnostics do) reads as the
 * tree it parses to, the same reading the fold has of the compiled copy; `signatures` is what
 * its calls are checked against (the function table's, which kernel code cannot hold), and
 * with none given a formula that calls a function reads as no rule. `hostKnown`: the server was
 * given a host context, so a `host.` read is replayable ({@link kernelRuleSkipped}).
 */
export function kernelFoldRuleUnreplayable(
  source: unknown,
  key: string,
  today: string | undefined,
  signatures?: FormulaFunctionSignature[],
  hostKnown?: boolean
): boolean {
  const expression = kernelRuleExpression(source, kernelParseFormula, Array.isArray(signatures) ? signatures : []);
  if (expression === undefined) {
    return false;
  }
  return (hostKnown !== true && kernelExprReadsHost(expression)) || !kernelRuleRunsOn(source, key, "server") || (today === undefined && kernelExprReadsClock(expression));
}

/**
 * Whether a component's visibility depends on the host: its own `rules.visibleWhen`, or any
 * ancestor's, reads a `host.` path, or, as rules carry a `run` scope and may read the
 * clock, is otherwise one the server cannot replay ({@link kernelFoldRuleUnreplayable}: a
 * `browser`-only rule, a clock-reading rule on a side with no day). The one static fact that decides how a form
 * field a journey places on no page is folded. The server has no host context, so it cannot
 * replay such a visibility (`kernelResolveSemanticState`, `validation/wasm/portable-kernel.ts`,
 * leaves the rule unevaluated), while the browser follows the host; a field on no page is on no
 * screen, so a browser that judged it by the host would refuse or accept what a server judges
 * the other way. Both sides therefore keep the lenient fold for such a field
 * ({@link kernelPlacedSemanticState}). Read from the tree on both sides, so both reach the same
 * answer, and by truthiness, as every rule reader reads a rule (`rules: null` is no rule). The
 * whole ancestor chain counts, a structural ancestor (one holding a listed component) included:
 * a field hidden with its host-shown fieldset is as unreplayable as one hiding itself. Enabled
 * or read-only rules do not affect validation; a `requiredWhen` reading `host.` has its own
 * reading ({@link kernelFoldRequiredReadsHost}). The journey diagnostics name such a field.
 */
export function kernelFoldVisibilityReadsHost(
  id: string,
  nodeById: Record<string, ComponentNode>,
  parentOf: Record<string, string>,
  today?: string,
  signatures?: FormulaFunctionSignature[]
): boolean {
  let current: string | undefined = id;
  // The node and its ancestors: at most the depth cap of them, whatever the parent map holds.
  for (let step = 0; current !== undefined && step < kernelMaxComponentDepth(); step += 1) {
    const node = kernelOwn(nodeById, current);
    if (node !== undefined) {
      const rules = node.rules;
      if (rules && rules.visibleWhen && kernelFoldRuleUnreplayable(rules.visibleWhen, "visibleWhen", today, signatures)) {
        return true;
      }
    }
    current = kernelOwn(parentOf, current);
  }
  return false;
}

/**
 * Whether a component's own `rules.requiredWhen` reads a `host.` path. For a form
 * field a journey places on no page, such a rule is read by neither side: the kernel never
 * evaluates a rule reading `host.` (`kernelRuleRequired` answers false, the lenient
 * direction), and a browser told the host would hold the person to a Required on a field no
 * page of the journey shows — a verdict nobody can act on, where the server accepts the same
 * envelope. On a page, the browser still follows the host (it is
 * never stricter than the browser to skip the rule on the server). The same holds for a rule
 * the server cannot otherwise replay ({@link kernelFoldRuleUnreplayable}). Read by truthiness,
 * as every rule reader reads a rule. The journey diagnostics name such a field.
 */
export function kernelFoldRequiredReadsHost(node: ComponentNode, today?: string, signatures?: FormulaFunctionSignature[]): boolean {
  const rules = node.rules;
  return Boolean(rules && rules.requiredWhen && kernelFoldRuleUnreplayable(rules.requiredWhen, "requiredWhen", today, signatures));
}

/**
 * Whether a component's own `rules.validWhen` is one the server cannot replay: it
 * reads `host.`, runs `browser`, or reads the clock with no day ({@link kernelFoldRuleUnreplayable}).
 * For a form field a journey places on no page such a check is read by neither side, as
 * {@link kernelFoldRequiredReadsHost} keeps a `requiredWhen` unread: the browser would refuse, on
 * a field no page shows, an answer the server accepts. Read by truthiness, as every rule is.
 */
export function kernelFoldValidReadsHost(node: ComponentNode, today?: string, signatures?: FormulaFunctionSignature[]): boolean {
  const rules = node.rules;
  return Boolean(rules && rules.validWhen && kernelFoldRuleUnreplayable(rules.validWhen, "validWhen", today, signatures));
}

/**
 * The server's reading of a visibility it cannot replay: a
 * component whose own `visibleWhen`, or any ancestor's, is one this side cannot evaluate
 * ({@link kernelFoldRuleUnreplayable}: it reads `host.`, is scoped to the browser, or reads the
 * clock with no day) may be hidden in the browser that can, and a browser never asks a person
 * for an answer to a question it hides. So the server does not ask either: such a component is
 * treated as hidden for requiredness, its tick and its `requiredWhen` both set aside in
 * `required` (edited in place), unless it says hidden fields stay required
 * (`hiddenRequiredBehavior: "required"`, which holds whether it is shown or not). Only
 * requiredness is read as hidden: the node stays visible by its configuration for validation
 * and for its answer's hidden-value policy, which is untouched (a forged value for a field
 * hidden to some viewers is kept). The browser, which can replay the rule, keeps
 * its own reading. `order` is document pre-order, root first, so a parent is read before its
 * children; the root is never relaxed. Returns the ids whose own `visibleWhen` was skipped, in
 * document order, which the outcome lists as `visibilitySkipped`. `hostKnown`: the run was given
 * a host context, so a visibility reading `host.` was replayed and is not relaxed here.
 */
export function kernelFoldRelaxUnreplayable(
  order: string[],
  nodeById: Record<string, ComponentNode>,
  parentOf: Record<string, string>,
  required: Record<string, boolean>,
  today: string | undefined,
  hostKnown?: boolean
): string[] {
  const skipped: string[] = [];
  const covered = kernelRecord() as Record<string, boolean>;
  for (let position = 1; position < order.length; position += 1) {
    const id = order[position] as string;
    const node = kernelOwn(nodeById, id);
    if (node === undefined) {
      continue;
    }
    const parent = kernelOwn(parentOf, id);
    let unreplayable = parent !== undefined && kernelOwn(covered, parent) === true;
    const rules = node.rules;
    if (rules && rules.visibleWhen && kernelFoldRuleUnreplayable(rules.visibleWhen, "visibleWhen", today, undefined, hostKnown)) {
      skipped.push(id);
      unreplayable = true;
    }
    covered[id] = unreplayable;
    if (unreplayable && kernelOwn(required, id) === true && kernelReadEnum(node.configuration, "hiddenRequiredBehavior", ["required", "not-required"]) !== "required") {
      required[id] = false;
    }
  }
  return skipped;
}

/**
 * A component's semantic state once the journey has placed it. On the path: its own. Off the
 * path (only on pages the path skips): hidden, never validated or required, its answer kept
 * or dropped by its own `hiddenValueBehavior`, else the journey's `offPathValues`, else
 * excluded. On no page: its own, exactly as the whole form folds it — its own visibility, its
 * own Required, its own value behaviour (form rules always hold) — unless its
 * visibility reads `host.` (`visibilityReadsHost`, from {@link kernelFoldVisibilityReadsHost}:
 * its own rule or an ancestor's), when it keeps the lenient fold on both sides: hidden, never
 * validated or required, its answer kept by its own `hiddenValueBehavior`, else retained. That
 * retained answer is no hidden-field default (which leaves a hidden answer out, see
 * `computeEffectiveNodeState`): neither side can tell whether such a field is shown, and an
 * answer a host or a default filled in stays in the submission rather than being dropped unseen.
 */
export function kernelPlacedSemanticState(
  own: SemanticNodeState,
  placement: JourneyPlacement | undefined,
  offPathValues: HiddenValueBehavior | undefined,
  visibilityReadsHost: boolean
): SemanticNodeState {
  if (placement === undefined || placement === "on") {
    return own;
  }
  if (placement === "unassigned" && !visibilityReadsHost) {
    return own;
  }
  const hiddenValueBehavior: HiddenValueBehavior =
    placement === "off" ? own.hiddenValueBehavior ?? offPathValues ?? "exclude-from-submission" : own.hiddenValueBehavior ?? "retain";
  return {
    visible: false,
    disabled: own.disabled,
    readonly: own.readonly,
    hiddenValueBehavior,
    hiddenValidationBehavior: "skip",
    hiddenRequiredBehavior: "not-required"
  };
}

/**
 * Whether a component holds an answer of its own — the one `required` and `requiredWhen` can
 * speak about. False for the form root, for a repeating section (`collection`, a data grid among
 * them), for a group — anything with a `children` map, or a grouping type even when a
 * hand-written tree leaves the map out (the `GROUP_TYPES` of `core/tree/data-scope.ts`,
 * `dataGrid` and `container` and its data-scoping kind included) —
 * and for a component that carries no answer: a button, static HTML, an image, a signature. The
 * leaf reading of `holdsData` (`core/tree/data-scope.ts`), which the kernel's `kernelClaimsData`
 * builds on. A `requiredWhen` on any of these is never read: such a node's value is always
 * empty, so the rule would refuse every submission while it held.
 */
export function kernelFoldHoldsOwnAnswer(node: ComponentNode): boolean {
  if (node.collection !== undefined || node.children !== undefined) {
    return false;
  }
  const groupTypes = [
    "form",
    "fieldset",
    "panel",
    "grid",
    "tabs",
    "tab",
    "steps",
    "step",
    "repeatingSection",
    "dataGrid",
    "container"
  ];
  if (groupTypes.indexOf(node.type) >= 0) {
    return false;
  }
  return ["button", "html", "image", "signature"].indexOf(node.type) < 0;
}

/**
 * Whether a component sits inside a repeating section: an ancestor with a `collection`. Its
 * answers live in the entries, one per row, which neither side folds row by row (the kernel
 * skips such calculations too), so a `requiredWhen` there is never read: the rule
 * would hold a form-level answer against every entry at once.
 */
export function kernelFoldInSection(id: string, nodeById: Record<string, ComponentNode>, parentOf: Record<string, string>): boolean {
  let parent = kernelOwn(parentOf, id);
  // Bounded by the depth cap, as every walk up the parents is.
  for (let step = 1; parent !== undefined && step < kernelMaxComponentDepth(); step += 1) {
    const ancestor = kernelOwn(nodeById, parent);
    if (ancestor !== undefined && ancestor.collection !== undefined) {
      return true;
    }
    parent = kernelOwn(parentOf, parent);
  }
  return false;
}

/**
 * Each component's requiredness over the settled view: `configuration.required`
 * (read as `kernelReadFlag` reads every flag), or — for a component that holds an answer of its
 * own and sits in no repeating section — its `rules.requiredWhen` holding, as `ruleRequired`
 * says. The rule adds to the tick and never removes it: both checkers already held a ticked
 * field to its tick whatever the rule said, so letting the rule win would loosen enforced
 * verdicts. Every node but the root (`order[0]`), in document order, in a prototype-free record;
 * without `ruleRequired`, only the tick counts. A component in `ruleUnread` (the components on
 * no page of a journey whose rule reads `host.`, {@link kernelFoldRequiredReadsHost}) keeps its
 * tick alone on both sides.
 */
export function kernelFoldRequired(
  order: string[],
  nodeById: Record<string, ComponentNode>,
  parentOf: Record<string, string>,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  ruleRequired: KernelFoldInput["ruleRequired"],
  ruleUnread?: Record<string, boolean>
): Record<string, boolean> {
  const required = kernelRecord() as Record<string, boolean>;
  for (let position = 1; position < order.length; position += 1) {
    const id = order[position] as string;
    const node = kernelOwn(nodeById, id);
    if (node === undefined) {
      continue;
    }
    let value = kernelReadFlag(node.configuration, "required");
    // The rule is read by truthiness, as every other rule reader reads one: a hand-written
    // `rules: null` or `requiredWhen: null` is no rule, never a crash.
    const rules = node.rules;
    if (
      !value &&
      ruleRequired !== undefined &&
      rules &&
      rules.requiredWhen &&
      (ruleUnread === undefined || kernelOwn(ruleUnread, id) !== true) &&
      kernelFoldHoldsOwnAnswer(node) &&
      !kernelFoldInSection(id, nodeById, parentOf)
    ) {
      value = ruleRequired(node, idValues, pathValues) === true;
    }
    required[id] = value;
  }
  return required;
}

/**
 * The components whose `rules.validWhen` does not hold over the settled view: read,
 * through `ruleValid`, exactly where {@link kernelFoldRequired} reads a `requiredWhen` — a
 * component holding an answer of its own ({@link kernelFoldHoldsOwnAnswer}), in no repeating
 * section ({@link kernelFoldInSection}), not in `ruleUnread` (a component on no page of a journey
 * whose check the server cannot replay, {@link kernelFoldValidReadsHost}). Only the failing ones
 * are listed (`true`), in document order, in a prototype-free record; without `ruleValid`, none.
 * By truthiness, as every rule is read: `validWhen: null` is no rule.
 */
export function kernelFoldInvalid(
  order: string[],
  nodeById: Record<string, ComponentNode>,
  parentOf: Record<string, string>,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  ruleValid: KernelFoldInput["ruleValid"],
  ruleUnread?: Record<string, boolean>
): Record<string, boolean> {
  const invalid = kernelRecord() as Record<string, boolean>;
  if (ruleValid === undefined) {
    return invalid;
  }
  for (let position = 1; position < order.length; position += 1) {
    const id = order[position] as string;
    const node = kernelOwn(nodeById, id);
    const rules = node !== undefined ? node.rules : undefined;
    if (
      node === undefined ||
      !rules ||
      !rules.validWhen ||
      (ruleUnread !== undefined && kernelOwn(ruleUnread, id) === true) ||
      !kernelFoldHoldsOwnAnswer(node) ||
      kernelFoldInSection(id, nodeById, parentOf)
    ) {
      continue;
    }
    if (ruleValid(node, idValues, pathValues) !== true) {
      invalid[id] = true;
    }
  }
  return invalid;
}

/**
 * What each data grid's `rules.minRows` and `rules.maxRows` come to over the settled view:
 * grid id -> `{ min?, max? }`, each key present when the grid has that rule and
 * `ruleRowBound` was asked, in document order, in a prototype-free record. A bound is the whole
 * grid's, read form-scoped: a rule whose tree reads `row.` is never evaluated (the compile warns
 * `rule.unsupportedScope`), nor is one on a component that is not a grid, nor one in a form the
 * caller gave no `ruleRowBound`. Unlike `requiredWhen`, a grid is read inside a repeating
 * section too: its bound reads the form's answers, not the entry's. `undefined` when no grid
 * carries such a rule, so the fold's result keeps its shape for every other form. By
 * truthiness, as every rule is read: `minRows: null` is no rule.
 */
export function kernelFoldRowBounds(
  order: string[],
  nodeById: Record<string, ComponentNode>,
  idValues: Record<string, unknown>,
  pathValues: Record<string, unknown>,
  ruleRowBound: KernelFoldInput["ruleRowBound"]
): Record<string, { min?: unknown; max?: unknown }> | undefined {
  if (ruleRowBound === undefined) {
    return undefined;
  }
  let bounds: Record<string, { min?: unknown; max?: unknown }> | undefined;
  for (let position = 0; position < order.length; position += 1) {
    const id = order[position] as string;
    const node = kernelOwn(nodeById, id);
    const rules = node !== undefined ? node.rules : undefined;
    if (node === undefined || node.type !== "dataGrid" || !rules || (!rules.minRows && !rules.maxRows)) {
      continue;
    }
    const read: { min?: unknown; max?: unknown } = {};
    let any = false;
    const minTree = rules.minRows ? kernelCompiledRule(rules.minRows) : undefined;
    if (minTree !== undefined && !kernelTreeReadsRow(minTree)) {
      read.min = ruleRowBound(node, "minRows", idValues, pathValues);
      any = true;
    }
    const maxTree = rules.maxRows ? kernelCompiledRule(rules.maxRows) : undefined;
    if (maxTree !== undefined && !kernelTreeReadsRow(maxTree)) {
      read.max = ruleRowBound(node, "maxRows", idValues, pathValues);
      any = true;
    }
    if (!any) {
      continue;
    }
    if (bounds === undefined) {
      bounds = kernelRecord() as Record<string, { min?: unknown; max?: unknown }>;
    }
    bounds[id] = read;
  }
  return bounds;
}

/** Whether two answer maps hold the same keys with the same values. */
export function kernelSameAnswers(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

/**
 * The fold (see the module comment). Each pass:
 *  1. resolves every node's own state over the current view;
 *  2. with a journey, places each component — first the ones on no page (a static fact:
 *     folded as the whole form folds them, bar one whose visibility reads `host.`, which stays
 *     hidden and unchecked on both sides), then works out the path over the answers that placement leaves
 *     submittable (a page's answers join a condition's view only once the page is on the
 *     path), and folds everything off the path to hidden — bar the ancestors of components on
 *     it;
 *  3. folds ancestors and applies the hidden-value policy to the raw answers.
 * It stops when the view the rules read stops changing, or after ten passes. The answers are
 * read as the envelope carries them ({@link kernelJsonAnswers}), and the rules and the journey
 * read only the keys the schema defines ({@link kernelFoldRuleView}).
 *
 * Then, settled or not, it works out each component's requiredness over the last view
 * ({@link kernelFoldRequired}) — on both sides, so a `requiredWhen` the browser
 * enforces is one the server enforces over the same answers; a component on no page whose rule
 * reads `host.` keeps its tick alone on both ({@link kernelFoldRequiredReadsHost}).
 */
export function kernelFoldSubmittable(input: KernelFoldInput): KernelFoldResult {
  // A journey's ownership carries the same map, built from the same tree: a caller that gives
  // the fold a journey but no owners of its own still has a section's entries judged by it.
  const collectionOwners =
    input.collectionOwners ?? (input.journey !== undefined ? input.journey.ownership.collectionOwners : undefined);
  const values = kernelJsonAnswers(input.values);
  let view: Record<string, unknown> = kernelFoldRuleView(values, input.defines);
  // Whether `view` is still the rule view of the raw answers: until a pass changes it, a policy
  // that dropped and cleared nothing hands back those same answers, so its rule view is `view`.
  let viewIsRaw = true;
  let passes = 0;
  let converged = false;
  let semantic = kernelRecord() as Record<string, SemanticNodeState>;
  let effective = kernelRecord() as Record<string, EffectiveNodeState>;
  let submittable: Record<string, unknown> = values;
  let trace: JourneyTrace | undefined;
  let placements: Record<string, JourneyPlacement> | undefined;
  // Re-keyed once per distinct view: the pass reads it, and so does the requiredness at the end.
  let idValues = kernelRekeyById(view, input.idsByPath);

  // With a journey, which components no page lists is a static fact, and so is whether such a
  // component's visibility — its own rule's or an ancestor's — reads `host.`, or its own
  // `requiredWhen` does: all worked out once, before any pass. The root and the
  // structural ancestors of listed components are never placed.
  const unassigned = kernelRecord() as Record<string, JourneyPlacement>;
  const hostBound = kernelRecord() as Record<string, boolean>;
  const ruleUnread = kernelRecord() as Record<string, boolean>;
  // The same for a component's own `validWhen`.
  const validUnread = kernelRecord() as Record<string, boolean>;
  if (input.journey !== undefined) {
    const ownership = input.journey.ownership;
    for (const id of input.order) {
      if (id === ownership.rootId || kernelOwn(ownership.structural, id) === true) {
        continue;
      }
      const owners = kernelOwn(ownership.pagesOf, id);
      if (owners === undefined || owners.length === 0) {
        unassigned[id] = "unassigned";
        if (kernelFoldVisibilityReadsHost(id, input.nodeById, input.parentOf, input.today)) {
          hostBound[id] = true;
        }
        const node = kernelOwn(input.nodeById, id);
        if (node !== undefined && kernelFoldRequiredReadsHost(node, input.today)) {
          ruleUnread[id] = true;
        }
        if (node !== undefined && kernelFoldValidReadsHost(node, input.today)) {
          validUnread[id] = true;
        }
      }
    }
  }

  while (passes < 10) {
    passes += 1;
    const own = kernelRecord() as Record<string, SemanticNodeState>;
    for (const id of input.order) {
      const node = kernelOwn(input.nodeById, id);
      if (node !== undefined) {
        own[id] = input.resolve(node, idValues, view);
      }
    }

    semantic = own;
    if (input.journey !== undefined) {
      const ownership = input.journey.ownership;
      const offPathValues = input.journey.journey.offPathValues;
      // Components on no page are placed before the path is known: that does not depend on it.
      const placedUnassigned = kernelRecord() as Record<string, SemanticNodeState>;
      for (const id of Object.keys(own)) {
        placedUnassigned[id] = kernelPlacedSemanticState(
          own[id] as SemanticNodeState,
          kernelOwn(unassigned, id),
          offPathValues,
          kernelOwn(hostBound, id) === true
        );
      }
      const beforePath = kernelFoldEffective(input.order, input.parentOf, placedUnassigned);
      // The journey's conditions read the day the fold was given, as every rule does.
      const journeyEvaluate = input.journey.evaluate;
      const today = input.today;
      const walk = input.journey.path;
      const place = input.journey.place;
      trace = walk(input.journey.journey, {
        values: kernelRekeyById(
          kernelFoldRuleView(kernelApplyValuePolicy(values, beforePath, input.idsByPath, collectionOwners), input.defines),
          input.idsByPath
        ),
        ownership,
        evaluate: function (expression, conditionValues) {
          return journeyEvaluate(expression, conditionValues, today);
        }
      });
      placements = place(ownership, trace);
      // A component on the path may sit inside one only on pages the path skips (a field listed
      // on a page of its own and, through its section, on another). Folding the section would
      // hide the field its page shows — and drop from the submission an answer the path has
      // just read, which a server could then not follow. Such an ancestor is left unfolded,
      // like a structural one; its other descendants are off in their own right.
      for (const id of input.order) {
        if (kernelOwn(placements, id) !== "on") {
          continue;
        }
        let parent = kernelOwn(input.parentOf, id);
        // Bounded by the depth cap, as every walk up the parents is.
        for (let step = 1; parent !== undefined && step < kernelMaxComponentDepth(); step += 1) {
          if (kernelOwn(placements, parent) === "off") {
            delete placements[parent];
          }
          parent = kernelOwn(input.parentOf, parent);
        }
      }
      const placed = kernelRecord() as Record<string, SemanticNodeState>;
      for (const id of Object.keys(own)) {
        placed[id] = kernelPlacedSemanticState(
          own[id] as SemanticNodeState,
          kernelOwn(placements, id),
          offPathValues,
          kernelOwn(hostBound, id) === true
        );
      }
      semantic = placed;
    }

    effective = kernelFoldEffective(input.order, input.parentOf, semantic);
    const policy = { changed: false };
    submittable = kernelApplyValuePolicy(values, effective, input.idsByPath, collectionOwners, policy);
    if (viewIsRaw && !policy.changed) {
      converged = true;
      break;
    }
    const next = kernelFoldRuleView(submittable, input.defines);
    if (kernelSameAnswers(next, view)) {
      converged = true;
      break;
    }
    view = next;
    viewIsRaw = false;
    idValues = kernelRekeyById(view, input.idsByPath);
  }

  const result: KernelFoldResult = {
    semantic,
    effective,
    submittable,
    idValues,
    required: kernelFoldRequired(input.order, input.nodeById, input.parentOf, idValues, view, input.ruleRequired, ruleUnread),
    invalid: kernelFoldInvalid(input.order, input.nodeById, input.parentOf, idValues, view, input.ruleValid, validUnread),
    converged,
    passes
  };
  // A data grid's bound formulas, over the same settled view as the requiredness.
  const rowBounds = kernelFoldRowBounds(input.order, input.nodeById, idValues, view, input.ruleRowBound);
  if (rowBounds !== undefined) {
    result.rowBounds = rowBounds;
  }
  if (trace !== undefined) {
    result.trace = trace;
  }
  if (placements !== undefined) {
    result.placements = placements;
  }
  return result;
}

/** For the sandbox program: every function above. */
export const SUBMITTABLE_FOLD_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelOwn,
  kernelRecord,
  kernelJsonValue,
  kernelJsonAnswers,
  kernelFoldRuleView,
  kernelFoldLeadingSegment,
  kernelFoldCollectionOwner,
  kernelRekeyById,
  kernelApplyValuePolicy,
  kernelFoldEffective,
  kernelCompiledRule,
  kernelRuleSkipped,
  kernelFoldRuleUnreplayable,
  kernelFoldVisibilityReadsHost,
  kernelFoldRequiredReadsHost,
  kernelFoldValidReadsHost,
  kernelFoldRelaxUnreplayable,
  kernelPlacedSemanticState,
  kernelFoldHoldsOwnAnswer,
  kernelFoldInSection,
  kernelFoldRequired,
  kernelFoldInvalid,
  kernelFoldRowBounds,
  kernelSameAnswers,
  kernelFoldSubmittable
];
