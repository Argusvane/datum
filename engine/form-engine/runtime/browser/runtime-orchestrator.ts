import type { EventBus } from "../../core/events/event-bus.js";
import { FormEventType } from "../../core/events/event-types.js";
import type { ComponentNode, ComponentRules } from "../../core/schema/types.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import type { FormState, FormValues } from "../../core/state/form-state.js";
import type { EffectiveNodeState, SemanticNodeState } from "../../core/state/effective-state.js";
import type { JourneyPlacement, JourneyTrace } from "../../core/journey/journey-types.js";
import type { PresentationIndex } from "../../core/journey/presentation.js";
// A running presentation's worked-out values and overlay are the journey engine's.
import { defaultJourneyEngine, type JourneyEngine, type PresentationOverlay } from "./journey-engine.js";
import { kernelBaseSemanticState } from "../../core/state/semantic-state.js";
import {
  kernelFoldSubmittable,
  kernelJsonAnswers,
  kernelJsonValue,
  kernelOwn,
  type KernelFoldJourney,
  type KernelFoldResult
} from "../../core/state/submittable-fold.js";
import {
  buildComponentIdsByPath,
  buildValuePaths,
  collectionPathOf,
  valuesByComponentId
} from "../../core/tree/data-scope.js";
import { dataGridSettingsOf, isDataGrid, resolveDataGridRowBounds } from "../../core/schema/data-grid.js";
import { evaluateExpression, kernelExprPluginProblem, type RuleEvaluationContext } from "../../rules/evaluator/evaluator.js";
import type { Expression } from "../../core/expressions/expression.js";
import { kernelRuleExpression, kernelRuleRunsOn } from "../../core/expressions/compile.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { DependencyGraph } from "../../rules/dependencies/dependency-graph.js";
import {
  kernelClaimsData,
  kernelDefinesKey,
  kernelKnownKeyShapes,
  kernelRowFields,
  kernelRowIndexes,
  kernelRowValues,
  kernelStableStringify
} from "../../validation/wasm/portable-kernel.js";

export interface SemanticResolutionContext {
  values: FormValues;
  locale: string;
  hostContext: Record<string, unknown>;
  valueOf(componentId: string): unknown;
  ancestorValuesFor(componentId: string): Record<string, unknown>;
  /** The calendar day this recompute evaluates with (`YYYY-MM-DD`), read by `today()` and `age()`. */
  today?: string;
  /** The plugin formula functions, by name. */
  functions?: Record<string, (args: unknown[]) => unknown>;
  /** Where a formula function says what it did not do (a size cap tripped), once per message. */
  warn?: (message: string) => void;
  /** The runtime's compiled `matches` patterns, shared by every context it builds. */
  regexCache?: Record<string, unknown>;
  /**
   * The tree a rule holds, or `undefined` when this side does not apply it: absent,
   * unparseable, or scoped (`run`) to the other side. What every rule reader here reads
   * through ({@link RuntimeOrchestrator.ruleOf}); absent on a context a host built by hand,
   * which then reads a tree rule as written.
   */
  rule?: (rules: ComponentRules, key: ComponentRuleKey) => Expression | undefined;
}

/** The rule keys a component carries. */
export type ComponentRuleKey = keyof ComponentRules;

/**
 * The tree a rule holds for the browser, through a context: the context's own reader when it
 * has one, else the rule as written when it is a tree (the pre-formula reading, for a host's
 * hand-built context).
 */
function browserRule(rules: ComponentRules | undefined, key: ComponentRuleKey, context: SemanticResolutionContext): Expression | undefined {
  if (!rules) {
    return undefined;
  }
  if (context.rule !== undefined) {
    return context.rule(rules, key);
  }
  const source = rules[key];
  return source !== null && typeof source === "object" && typeof (source as { kind?: unknown }).kind === "string" ? (source as Expression) : undefined;
}

/**
 * Produces the per-node {@link SemanticNodeState} the orchestrator feeds into
 * `computeEffectiveNodeState` (through the fold, `core/state/submittable-fold.ts`).
 */
export interface SemanticStateResolver {
  resolve(node: ComponentNode, context: SemanticResolutionContext): SemanticNodeState;
}

function ruleContext(
  node: ComponentNode,
  context: SemanticResolutionContext
): RuleEvaluationContext {
  return {
    values: context.values,
    hostContext: context.hostContext,
    componentValue: context.valueOf(node.id),
    ancestorValues: context.ancestorValuesFor(node.id),
    ...(context.today !== undefined ? { today: context.today } : {}),
    ...(context.functions !== undefined ? { functions: context.functions } : {}),
    ...(context.warn !== undefined ? { warn: context.warn } : {}),
    ...(context.regexCache !== undefined ? { regexCache: context.regexCache } : {})
  };
}

/** Derives semantic state from static configuration flags only. */
export class ConfigurationSemanticStateResolver implements SemanticStateResolver {
  public resolve(node: ComponentNode): SemanticNodeState {
    return kernelBaseSemanticState(node);
  }
}

/**
 * Default resolver: evaluates `node.rules` (`visibleWhen` / `enabledWhen` / `readonlyWhen`)
 * against scoped contexts, falling back to configuration flags when a rule is absent. A rule
 * scoped to the server (`run: "server"` or `"server-secret"`) is absent here: the browser
 * leaves it to the kernel.
 */
export class RulesSemanticStateResolver implements SemanticStateResolver {
  public resolve(node: ComponentNode, context: SemanticResolutionContext): SemanticNodeState {
    const state = kernelBaseSemanticState(node);
    const rules = node.rules;
    if (!rules) {
      return state;
    }

    const ctx = ruleContext(node, context);
    const visibleWhen = browserRule(rules, "visibleWhen", context);
    if (visibleWhen) {
      state.visible = evaluateExpression(visibleWhen, ctx) === true;
    }
    const enabledWhen = browserRule(rules, "enabledWhen", context);
    if (enabledWhen) {
      state.disabled = evaluateExpression(enabledWhen, ctx) !== true;
    }
    const readonlyWhen = browserRule(rules, "readonlyWhen", context);
    if (readonlyWhen) {
      state.readonly = evaluateExpression(readonlyWhen, ctx) === true;
    }
    // The target of a calculation the browser runs (`rules.value`) is read-only: the rule writes
    // the value back on every recompute, so a typed answer would be overwritten at once.
    // A derived state, stored nowhere; a calculation scoped to the server is no rule here,
    // so its field stays editable. The sandbox kernel's fold is untouched (readonly is display).
    if (browserRule(rules, "value", context)) {
      state.readonly = true;
    }
    return state;
  }
}

export interface RecomputeResult {
  effectiveStates: ReadonlyMap<string, EffectiveNodeState>;
  effectiveValues: FormValues;
  /**
   * Each component's requiredness before the hidden-required policy: its
   * `configuration.required`, OR its `rules.requiredWhen` holding over the settled view where
   * the fold reads it. Every component but the root, in document order.
   */
  requiredByNode: ReadonlyMap<string, boolean>;
  computedWrites: ReadonlyArray<{ componentId: string; value: unknown }>;
  /** The active journey's path over these answers, when a journey is running. */
  journeyTrace?: JourneyTrace;
  /** False when the fold hit its pass limit: rules feeding each other through hidden answers. */
  converged: boolean;
  /**
   * False when the running presentation's worked-out values did not settle: which
   * of their sources show kept changing with what they wrote. True without a presentation.
   */
  mappingsSettled: boolean;
}

/**
 * The state of one node a presentation owns, from the last recompute: what the
 * overlay (the journey engine's `PresentationOverlay`) works out beside the fold, which
 * never sees such a node.
 */
export interface PresentationNodeState {
  effective: EffectiveNodeState;
  /**
   * What a required marker shows: the node's own Required or Required-when,
   * or — for an alias and for a worked-out value's copy — the form field's.
   */
  required: boolean;
  /** The node's own Required or Required-when alone: what its own validation holds it to. */
  ownRequired: boolean;
}

/** What {@link RuntimeOrchestrator.stateOf} answers: a node's state, whichever side owns it. */
export interface MergedNodeState {
  effective: EffectiveNodeState;
  required: boolean;
  /** Set for a node the running presentation owns. */
  own?: PresentationNodeState;
}

export interface RuntimeOrchestratorDependencies {
  eventBus: EventBus;
  formId: string;
  /** `"allow"` lets a `matches` pattern of a catastrophic shape run; default `"refuse"` (as the kernel). */
  riskyPatterns?: "refuse" | "allow" | undefined;
  semanticStateResolver?: SemanticStateResolver | undefined;
  hostContext?: Record<string, unknown> | undefined;
  /** Persists calculation / default-value write-backs (without marking the field dirty). */
  applyComputedValue?: ((componentId: string, value: unknown) => void) | undefined;
  /**
   * The journey running now, read on every recompute: its path folds every
   * component off it to hidden. Absent, or returning `undefined`, the whole form is in play.
   */
  journey?: (() => KernelFoldJourney | undefined) | undefined;
  /**
   * The index of the running journey's own nodes, read on every recompute beside
   * {@link journey}: absent, or `undefined`, for the whole form and for a journey of component
   * ids alone.
   */
  presentation?: (() => PresentationIndex | undefined) | undefined;
  /**
   * Keeps what a worked-out value wrote at a target's value path (`held`), or forgets it, in
   * the journey's state (`JourneyState.written`), which a draft carries.
   */
  recordWritten?: ((targetPath: string, value: unknown, held: boolean) => void) | undefined;
  /**
   * The calendar day the rules read (`today()`, `age()`), as `YYYY-MM-DD`, read once at the
   * top of every recompute so every rule of the same recompute sees one day. Absent, or
   * answering `undefined`, no rule reads a clock: a clock-reading rule is left unevaluated,
   * as a server given no day leaves it.
   */
  today?: (() => string | undefined) | undefined;
  /** The plugin formula functions, by name; on every rule context. */
  functions?: Record<string, (args: unknown[]) => unknown> | undefined;
  /**
   * The function signatures the parser checks a formula against, for a rule that reaches the
   * orchestrator as text: the built-ins' (`formulaFunctionSignatures()`) plus the plugins'.
   * A `FormRuntime` compiles its definition first, so none does; the default is the built-ins.
   */
  signatures?: readonly FormulaFunctionSignature[] | undefined;
  /**
   * The journey machinery a running {@link presentation}'s worked-out values and overlay are
   * asked of. Absent, the default engine (`setDefaultJourneyEngine`). Read only once a
   * presentation runs, which only an engine with journeys starts; a `FormRuntime` passes its own.
   */
  journeyEngine?: JourneyEngine | undefined;
}

/**
 * Deterministic recomputation layer. On each {@link recompute} it:
 *  1. runs calculation (`rules.value`) and default (`rules.defaultValue`) rules to a
 *     fixpoint over the answers as stored, writing results back through `applyComputedValue`;
 *  2. folds the answers to what is shown, validated and submitted with
 *     `kernelFoldSubmittable` — each node's {@link SemanticNodeState}, its ancestors folded in
 *     (`computeEffectiveNodeState`), the active journey's path, the hidden-value policy — over
 *     the submittable view until it is stable, and then, inside that same fold, each node's
 *     requiredness over the settled view: `configuration.required` OR `rules.requiredWhen`,
 * the rule evaluated by this class's `ruleRequired` callback.
 *
 * Step 2 is the function the validation sandbox runs too, so a server re-validating
 * a submission lands on the verdict the browser reached. It is also why rules read the
 * submittable view rather than the raw answers: an answer hidden and excluded from the
 * submission no longer feeds another rule, because a server never receives it.
 *
 * **Presentations.** Both steps work on the *form values*: the answers as stored
 * minus the keys a presentation's own fields live under ({@link formValues}). No calculation,
 * no rule, no journey condition and nothing submitted ever reads such a key — a server never
 * receives one. What a running presentation adds sits beside the pipeline, never in it:
 *  - before step 1, its **worked-out values** write the form fields they work out, from the
 *    own fields of their page that show;
 *  - after step 2, an **overlay** works out the state of the own nodes — shown, disabled,
 *    read-only, required — over the fold's view plus the own answers.
 * Which sources show depends on the overlay, and the overlay on the fold, so the three go
 * round until the set of readable sources stops changing, at most three times;
 * {@link lastMappingsSettled} says whether they did. Both are the journey engine's
 * (`PresentationOverlay`): this class hands it the fold, the calculations and its
 * rule machinery, and keeps what the rounds settled on.
 */
export class RuntimeOrchestrator {
  private readonly resolver: SemanticStateResolver;
  /** What `host.` reads; replaced whole by {@link setHostContext}, never edited in place. */
  private hostContext: Record<string, unknown>;
  private readonly dependencyGraph = new DependencyGraph();
  /** See {@link valueRuleReads}. */
  /** Each field of a section's entries -> its collection and its key within an entry (`kernelRowFields`), read once. */
  private rowFieldMap: Record<string, { collection: string; suffix: string }> | undefined;
  /** The ids of the nodes inside a collection-bound container, the container itself included, read once. */
  private collectionMembers: ReadonlySet<string> | undefined;
  private valueRuleReadIds: ReadonlySet<string> | undefined;
  /** See {@link valueRuleTargets}. */
  private valueRuleTargetPaths: ReadonlySet<string> | undefined;
  private readonly nodesInOrder: ComponentNode[];
  /**
   * The last recompute's per-node views: the fold's records, read point by point or as a Map
   * built only when something asks for the whole (a keystroke that nobody lists never pays
   * for it).
   */
  private views = new FoldViews(Object.create(null) as Record<string, EffectiveNodeState>, Object.create(null) as Record<string, boolean>, []);
  private get effective(): ReadonlyMap<string, EffectiveNodeState> {
    return this.views.effectiveMap();
  }
  private get required(): ReadonlyMap<string, boolean> {
    return this.views.requiredMap();
  }
  private effectiveValueView: FormValues = {};
  /**
   * Component id -> value path, and back. State is keyed by value path (so a data-scoping
   * `container` or a data key, places the data); rules, effective state and errors
   * are keyed by component id (so an author addresses a field by its own name wherever it
   * sits). This pair is the one place the two vocabularies meet. The way back lists every
   * component storing at a path: normally one, two only in a hand-written definition the
   * builder would refuse, and then both see the value.
   */
  private readonly valuePaths: Map<string, string>;
  private readonly componentIdsByPath: Map<string, string[]>;
  /**
   * The tree as the fold reads it — plain records built once, since the fold runs on every
   * keystroke and is shaped to run in the validation sandbox too (see `submittable-fold.ts`).
   */
  // Prototype-free, as the kernel's mirrors are: a component called `__proto__` (or a path
  // named so) must land as a key, not set the record's prototype, or the fold skips it in the
  // browser while the sandbox judges it.
  private readonly foldOrder: string[] = [];
  /** The ids of {@link nodesInOrder} once each (a duplicate id counts once, as the map keyed by id did). */
  private readonly uniqueIds: string[] = [];
  private readonly foldNodeById: Record<string, ComponentNode> = Object.create(null) as Record<string, ComponentNode>;
  private readonly foldParentOf: Record<string, string> = Object.create(null) as Record<string, string>;
  private readonly foldPathOf: Record<string, string> = Object.create(null) as Record<string, string>;
  private readonly foldIdsByPath: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  /**
   * Collection path -> the repeating section whose entries live there. A section
   * stored at its own `collectionPath` (`order_lines`, `order.items`) owns keys no value path
   * names: the fold and the hidden-value policy judge them as the section, so an abandoned
   * branch's entries are not submitted. A data grid is a section like any other: its
   * rows live at its collection path. The kernel's `kernelCollectionOwners` and the journey's
   * ownership register the same paths. Never mixed into `foldIdsByPath`, which re-keys the
   * answers rules read.
   */
  private readonly foldCollectionOwners: Record<string, string> = Object.create(null) as Record<string, string>;
  /**
   * The key shapes the schema defines — the sandbox's allowlist (`kernelKnownKeyShapes`) — and
   * each key's verdict once asked. The fold's rules and journey read only such keys,
   * as the kernel's do whatever its unknown-field mode keeps, so a value under a key no
   * component owns steers nothing in the browser that a server could not follow.
   */
  private readonly foldKnownShapes: Record<string, true>;
  private readonly foldDefined = new Map<string, boolean>();
  private readonly foldDefines = (key: string): boolean => {
    let defined = this.foldDefined.get(key);
    if (defined === undefined) {
      defined = kernelDefinesKey(this.foldKnownShapes, key);
      this.foldDefined.set(key, defined);
    }
    return defined;
  };
  private lastTrace: JourneyTrace | undefined;
  private lastPlacements: Record<string, JourneyPlacement> | undefined;
  private lastConverged = true;
  /**
   * The overlay of the last recompute: the state of each node the running
   * presentation owns. No prototype: an own id may be `constructor`.
   */
  private overlay: Record<string, PresentationNodeState> | undefined;
  private overlayOrder: readonly string[] = [];
  /** Form states with the overlay's laid over them, built when first asked for after a recompute. */
  private mergedEffective: ReadonlyMap<string, EffectiveNodeState> | undefined;
  private mergedRequiredMap: ReadonlyMap<string, boolean> | undefined;
  /** The journey machinery a running presentation is asked of; see {@link RuntimeOrchestratorDependencies.journeyEngine}. */
  private readonly journeyEngine: JourneyEngine;
  /**
   * The running presentation's worked-out values and overlay, bound to this
   * orchestrator when the first presentation runs: they remember which sources could be read
   * when the last recompute ended ({@link forgetReadable}).
   */
  private overlayRunner: PresentationOverlay | undefined;
  private lastSettled = true;
  /**
   * What each data grid's `rules.minRows` / `rules.maxRows` came to over the last recompute's
   * settled view (the fold's `rowBounds`); `undefined` when no grid carries such a rule.
   */
  private lastRowBounds: Record<string, { min?: unknown; max?: unknown }> | undefined;
  /** The form's data grids, in document order, read once. */
  private readonly gridNodes: ComponentNode[] = [];
  /** Whether some grid carries a bound formula: only then is the fold asked to read them. */
  private hasRowBoundRules = false;
  /** The day of the recompute in progress (and of the last one, for a gate asked between two). */
  private today: string | undefined;
  /** The parser's signatures, for a rule that is still text (none from a `FormRuntime`, which compiles first). */
  private readonly signatures: FormulaFunctionSignature[];
  /**
   * The plugin formula functions, wrapped to record a throw: the evaluator reads
   * a function that throws as `undefined`, and under `formulaErrors: "fail"` the
   * runtime refuses the submission for it, as the kernel does ({@link ruleFailures}).
   */
  private readonly functions: Record<string, (args: unknown[]) => unknown> | undefined;
  /** The formula warnings already said, so a rule re-read on every keystroke says each once. */
  private readonly warnedFormula = new Set<string>();
  /**
   * The patterns `matches` compiled, one object for the runtime: every rule context shares it.
   * It refuses a pattern of a catastrophic shape built at run time, as the sandbox kernel does,
   * unless the host allows risky patterns: this evaluator runs on the
   * page's main thread with no interrupt.
   */
  private readonly regexCache: Record<string, unknown>;

  /**
   * Where a formula function says what it did not do (a size cap tripped, a plugin result that
   * is not data): a console warning, once per message, as the kernel writes the same line to its
   * run log. The rule reads no answer meanwhile.
   */
  private readonly warnFormula = (message: string): void => {
    if (!this.warnedFormula.has(message)) {
      this.warnedFormula.add(message);
      console.warn(`[FormRuntime] formula function: ${message}`);
    }
  };
  /** The rule being evaluated now (`rules:<id>[:<key>]`), best effort: what a recorded throw is named by. */
  private evaluating = "";
  /** The plugin function throws of the last recompute, by rule and function. */
  private failedFunctions = new Map<string, { where: string; name: string; message: string }>();
  /**
   * Each rule source's tree, once read: a compiled rule is a tree already, and a formula
   * that reaches here as text is parsed once, not on every recompute.
   */
  private readonly ruleTrees = new Map<unknown, Expression | undefined>();

  constructor(
    private readonly tree: ComponentTree,
    private readonly deps: RuntimeOrchestratorDependencies
  ) {
    this.regexCache = deps.riskyPatterns === "allow" ? {} : { refuseRisky: true };
    this.resolver = deps.semanticStateResolver ?? new RulesSemanticStateResolver();
    this.journeyEngine = deps.journeyEngine ?? defaultJourneyEngine();
    this.hostContext = deps.hostContext ?? {};
    this.signatures = deps.signatures !== undefined ? [...deps.signatures] : formulaFunctionSignatures();
    this.functions = this.recordingFunctions(deps.functions);
    this.valuePaths = buildValuePaths(this.tree.getRoot());
    this.componentIdsByPath = buildComponentIdsByPath(this.tree.getRoot());
    this.foldKnownShapes = kernelKnownKeyShapes(this.tree.getRoot());

    for (const [componentId, path] of this.valuePaths) {
      this.foldPathOf[componentId] = path;
    }
    for (const [path, ids] of this.componentIdsByPath) {
      this.foldIdsByPath[path] = [...ids];
    }

    this.nodesInOrder = [];
    walkPreOrder(this.tree.getRoot(), (node, parent) => {
      this.nodesInOrder.push(node);
      this.foldOrder.push(node.id);
      if (isDataGrid(node)) {
        this.gridNodes.push(node);
        // By truthiness, as every rule is read: `minRows: null` is no formula.
        this.hasRowBoundRules = this.hasRowBoundRules || Boolean(node.rules?.minRows) || Boolean(node.rules?.maxRows);
      }
      if (kernelOwn(this.foldNodeById, node.id) === undefined) {
        this.uniqueIds.push(node.id);
      }
      this.foldNodeById[node.id] = node;
      // The root is not a section (the kernel's `kernelCollectionOwners` starts below it).
      const collectionPath = parent ? collectionPathOf(node) : undefined;
      if (collectionPath !== undefined && kernelOwn(this.foldCollectionOwners, collectionPath) === undefined) {
        this.foldCollectionOwners[collectionPath] = node.id;
      }
      // A parent that would close a loop is never recorded (the earlier one stays), as the
      // kernel's index does: every walk up the parents must end.
      if (parent && !this.closesParentLoop(node.id, parent.id)) {
        this.foldParentOf[node.id] = parent.id;
      }
      const rules = node.rules;
      if (!rules) {
        return;
      }
      // Only the rules this side applies: one scoped to the server is as if absent here.
      for (const key of ["visibleWhen", "enabledWhen", "readonlyWhen", "requiredWhen", "validWhen", "navigationGating", "filter"] as const) {
        const expression = this.ruleOf(rules, key);
        if (expression) {
          this.dependencyGraph.registerRule(node.id, expression);
        }
      }
      const value = this.ruleOf(rules, "value");
      if (value) {
        this.dependencyGraph.registerRule(node.id, value, true);
      }
      const defaultValue = this.ruleOf(rules, "defaultValue");
      if (defaultValue) {
        this.dependencyGraph.registerRule(node.id, defaultValue, true);
      }
    });

    const cycle = this.dependencyGraph.findCalculationCycle();
    if (cycle) {
      throw new Error(`Calculation rule cycle detected: ${cycle.join(" -> ")}`);
    }
  }

  /**
   * Whether recording `parent` as `child`'s parent would make the parents loop: `parent`'s own
   * chain already reaches `child`. The chain recorded so far never loops, so the walk ends.
   */
  private closesParentLoop(child: string, parent: string): boolean {
    for (let at: string | undefined = parent; at !== undefined; at = kernelOwn(this.foldParentOf, at)) {
      if (at === child) {
        return true;
      }
    }
    return false;
  }

  /**
   * The tree a rule holds for the browser: `undefined` when the rule is absent, when its
   * formula does not parse (a compiled definition has dropped it already), or when its `run`
   * scope keeps it from the browser (`server`, `server-secret`), which the browser treats as no
   * rule at all. The browser-only keys (`defaultValue`, `filter`, `navigationGating`) are always
   * the browser's. Read through the compile module's reader (`kernelRuleExpression`), which on a
   * compiled definition costs a shape check.
   */
  public ruleOf(rules: ComponentRules | undefined, key: ComponentRuleKey): Expression | undefined {
    if (!rules) {
      return undefined;
    }
    const source: unknown = rules[key];
    // By truthiness, as every rule is read: a hand-written `requiredWhen: null` is no rule.
    if (!source) {
      return undefined;
    }
    let expression = this.ruleTrees.get(source);
    if (expression === undefined && !this.ruleTrees.has(source)) {
      expression = kernelRuleExpression(source, kernelParseFormula, this.signatures);
      this.ruleTrees.set(source, expression);
    }
    // The browser evaluates `host.` reads itself and always reads the clock it was given
    // (`kernelRuleSkipped`'s other reasons are the server's): the skip here is the scope's.
    return expression !== undefined && kernelRuleRunsOn(source, key, "browser") ? expression : undefined;
  }

  public recompute(state: FormState, changedPaths?: string[]): RecomputeResult {
    const startedAt = Date.now();
    // One day for the whole recompute: every rule, calculation, worked-out value and journey
    // condition reads the same `today()`.
    this.today = this.deps.today?.();
    this.failedFunctions = new Map();
    this.evaluating = "";
    // The form pipeline works on form values alone: a presentation's own answers
    // are kept in the state and never reach a calculation, a rule or the fold.
    // A copy only where the pipeline writes into it (a calculation, a default, a worked-out
    // value) or a presentation's keys must come out; otherwise the passed answers are read as
    // they are and `state` is never touched (a snapshot copy on every keystroke was the cost).
    const journey = this.deps.journey?.();
    const presentation = journey !== undefined ? this.deps.presentation?.() : undefined;
    const working: FormValues = this.workingValues(state.values, presentation !== undefined || this.hasValueRules());

    const writes = new Map<string, unknown>();
    const note = (round: ReadonlyArray<{ componentId: string; value: unknown }>): void => {
      for (const write of round) {
        writes.set(write.componentId, write.value);
      }
    };

    let fold: KernelFoldResult;
    let overlay: Record<string, PresentationNodeState> | undefined;
    let settled = true;
    if (presentation === undefined) {
      note(this.runValueRules(working));
      fold = this.foldOver(working, state.locale, journey);
      this.overlayRunner?.forget();
    } else {
      // Worked-out values, the form's own calculations, the fold, the overlay — and round again
      // while which sources show keeps changing with what was written. The rounds are
      // the journey engine's; the fold and the calculations they go round are these.
      const rounds = this.presentationOverlay().recompute({
        presentation,
        working,
        stored: state.values,
        written: state.journey?.written,
        locale: state.locale,
        note,
        runValueRules: (values) => this.runValueRules(values),
        fold: (values) => this.foldOver(values, state.locale, journey)
      });
      fold = rounds.fold;
      overlay = rounds.overlay;
      settled = rounds.settled;
    }

    // With a journey, a calculation reads the settled view:
    // where one reads an answer the fold withheld, it is worked out again without
    // that answer and the fold re-run, as the server's kernel does over what it is sent.
    if (journey !== undefined) {
      const settledAgain = this.settleValueRules(working, fold, state.locale, journey, note);
      fold = settledAgain.fold;
      if (!settledAgain.settled) {
        fold.converged = false;
      }
    }

    // The views read the fold's records; a Map of either is built when something lists them.
    let nodeCount = 0;
    for (const id of this.uniqueIds) {
      if (kernelOwn(fold.effective, id)) {
        nodeCount += 1;
      }
    }
    const views = new FoldViews(fold.effective, fold.required, this.nodesInOrder, fold.invalid);
    this.views = views;
    this.effectiveValueView = fold.submittable;
    this.lastTrace = fold.trace;
    this.lastPlacements = fold.placements;
    this.lastConverged = fold.converged;
    this.overlay = overlay;
    this.overlayOrder = overlay !== undefined && presentation !== undefined ? presentation.order : [];
    this.mergedEffective = undefined;
    this.mergedRequiredMap = undefined;
    this.lastSettled = settled;
    this.lastRowBounds = fold.rowBounds;

    const computedWrites = [...writes].map(([componentId, value]) => ({ componentId, value }));
    this.deps.eventBus.publish({
      id: `recompute_${Date.now()}`,
      type: FormEventType.RECOMPUTE_COMPLETED,
      timestamp: Date.now(),
      source: "runtime",
      formId: this.deps.formId,
      data: {
        nodeCount,
        computedWriteCount: computedWrites.length,
        changedPaths: changedPaths ?? null,
        latencyMs: Date.now() - startedAt
      }
    });

    // The answers as submitted, copied when first read: nothing in the runtime reads this
    // field, and a copy of every key on every keystroke grows with the form.
    const submittable = fold.submittable;
    let effectiveValues: FormValues | undefined;
    const result: RecomputeResult = {
      get effectiveStates(): ReadonlyMap<string, EffectiveNodeState> {
        return views.effectiveMap();
      },
      get effectiveValues(): FormValues {
        effectiveValues ??= { ...submittable };
        return effectiveValues;
      },
      get requiredByNode(): ReadonlyMap<string, boolean> {
        return views.requiredMap();
      },
      computedWrites,
      converged: fold.converged,
      mappingsSettled: settled
    };
    if (fold.trace !== undefined) {
      result.journeyTrace = fold.trace;
    }
    return result;
  }

  /**
   * The plugin functions of `functions` with each throw recorded against the rule being
   * evaluated; the throw itself goes on, so what a rule reads is unchanged.
   */
  private recordingFunctions(
    functions: Record<string, (args: unknown[]) => unknown> | undefined
  ): Record<string, (args: unknown[]) => unknown> | undefined {
    if (functions === undefined) {
      return undefined;
    }
    const wrapped = Object.create(null) as Record<string, (args: unknown[]) => unknown>;
    for (const name of Object.keys(functions)) {
      const original = functions[name];
      if (typeof original !== "function") {
        wrapped[name] = original as never;
        continue;
      }
      wrapped[name] = (args: unknown[]): unknown => {
        try {
          const result = original(args);
          // A result that is not plain data (NaN, a promise, a function, a Date, a class
          // instance) is no answer: said once, named, and read as `undefined`, as the kernel does.
          const problem = kernelExprPluginProblem(result);
          if (problem !== undefined) {
            this.warnFormula(`the function "${name}" returned ${problem}; read as no answer`);
            return undefined;
          }
          return result;
        } catch (failure) {
          const where = this.evaluating;
          const key = `${where}\n${name}`;
          if (!this.failedFunctions.has(key)) {
            this.failedFunctions.set(key, { where, name, message: failure instanceof Error ? failure.message : String(failure) });
          }
          throw failure;
        }
      };
    }
    return wrapped;
  }

  /**
   * The plugin functions that threw while the last recompute evaluated a rule,
   * with the rule they were evaluated for (`rules:<componentId>[:<key>]`, best effort) and the
   * thrown message: what `formulaErrors: "fail"` refuses a submission for, as the kernel does.
   * Each rule read `undefined` meanwhile.
   */
  public ruleFailures(): ReadonlyArray<{ where: string; name: string; message: string }> {
    return [...this.failedFunctions.values()];
  }

  /**
   * Forgets which sources the worked-out values could read, for a caller that has
   * just replaced the answers wholesale — a draft put in. The next recompute then starts from
   * the new answers alone: it reads no source before the overlay has shown it under them, so it
   * never writes a worked-out value from a source those answers hide over a drafted target.
   */
  public forgetReadable(): void {
    this.overlayRunner?.forget();
  }

  /** The running presentation's worked-out values and overlay, bound to this orchestrator when first asked for. */
  private presentationOverlay(): PresentationOverlay {
    const orchestrator = this;
    this.overlayRunner ??= this.journeyEngine.presentationOverlay({
      // Read on every use, so a host context the page replaces reaches the overlay too.
      get hostContext(): Record<string, unknown> {
        return orchestrator.hostContext;
      },
      functions: this.functions,
      regexCache: this.regexCache,
      warn: this.warnFormula,
      today: () => this.today,
      ruleOf: (rules, key) => this.ruleOf(rules, key),
      resolve: (node, context) => this.resolver.resolve(node, context),
      evaluate: (rule, node, context) => evaluateExpression(rule, ruleContext(node, context)),
      applyComputedValue: (path, value) => this.deps.applyComputedValue?.(path, value),
      recordWritten: (targetPath, value, held) => this.deps.recordWritten?.(targetPath, value, held)
    });
    return this.overlayRunner;
  }

  /**
   * The calculation inputs: the ids every calculation and default reads, from the dependency
   * graph (a superset: a node's other rules count too). Worked out once, when a journey asks.
   */
  private valueRuleReads(): ReadonlySet<string> {
    if (this.valueRuleReadIds === undefined) {
      const reads = new Set<string>();
      for (const node of this.nodesInOrder) {
        if ((this.ruleOf(node.rules, "value") || this.ruleOf(node.rules, "defaultValue")) && kernelClaimsData(node)) {
          for (const read of this.dependencyGraph.dependenciesOf(node.id)) {
            reads.add(read);
          }
        }
      }
      this.valueRuleReadIds = reads;
    }
    return this.valueRuleReadIds;
  }

  /** The value paths a calculation writes (what a withheld answer must not be put back over). */
  private valueRuleTargets(): ReadonlySet<string> {
    if (this.valueRuleTargetPaths === undefined) {
      const targets = new Set<string>();
      for (const node of this.nodesInOrder) {
        if (this.ruleOf(node.rules, "value") && kernelClaimsData(node)) {
          targets.add(this.pathOf(node.id));
        }
      }
      this.valueRuleTargetPaths = targets;
    }
    return this.valueRuleTargetPaths;
  }

  /**
   * The calculations worked out over the settled view: with a journey, an
   * answer the fold withheld is no input to a calculation, so where one reads such an answer the
   * calculations run again over the answers less the withheld ones and the fold over all of them
   * (the fold decides afresh each round, so a key withheld once is not
   * withheld for good), until the withheld answers stop changing. The same loop as
   * `kernelFoldSubmission`'s, so a browser and a server land on the same view; a view that comes
   * back to one already tried is not settled, and neither is one that does not within the bound.
   */
  private settleValueRules(
    working: FormValues,
    first: KernelFoldResult,
    locale: string,
    journey: KernelFoldJourney,
    note: (round: ReadonlyArray<{ componentId: string; value: unknown }>) => void
  ): { fold: KernelFoldResult; settled: boolean } {
    const reads = this.valueRuleReads();
    if (reads.size === 0) {
      return { fold: first, settled: true };
    }
    const targets = this.valueRuleTargets();
    let fold = first;
    /** The views tried, in order; the first is the one worked out before any answer was withheld. */
    const tried: string[] = ["?"];
    let triedRead = false;
    for (let again = 0; again <= 5; again += 1) {
      const next = new Set<string>();
      let read = false;
      for (const key of Object.keys(working)) {
        if (working[key] !== undefined && kernelOwn(fold.submittable, key) === undefined && this.foldDefines(key)) {
          next.add(key);
          if (reads.has(key) || (this.componentIdsByPath.get(key) ?? []).some((id) => reads.has(id))) {
            read = true;
          }
        }
      }
      const key = [...next].sort().join("\n") + "\u0000";
      if (key === tried[tried.length - 1]) {
        return { fold, settled: true };
      }
      if (!read && !triedRead) {
        return { fold, settled: true };
      }
      if (tried.indexOf(key) >= 0 || again === 5) {
        break;
      }
      tried.push(key);
      triedRead = read;
      const view: FormValues = {};
      for (const held of Object.keys(working)) {
        if (!next.has(held)) {
          view[held] = working[held];
        }
      }
      note(this.runValueRules(view, next));
      // The fold sees the withheld answers again, bar a calculation's own: it decides afresh.
      const folded: FormValues = {};
      for (const held of Object.keys(working)) {
        if (next.has(held) && !targets.has(held) && !Object.prototype.hasOwnProperty.call(view, held)) {
          folded[held] = working[held];
        } else if (Object.prototype.hasOwnProperty.call(view, held)) {
          folded[held] = view[held];
        }
      }
      for (const held of Object.keys(view)) {
        if (!Object.prototype.hasOwnProperty.call(folded, held)) {
          folded[held] = view[held];
        }
      }
      fold = this.foldOver(folded, locale, journey);
    }
    return { fold, settled: false };
  }

  /** The shared fold over one set of form values: what is shown, validated and submitted. */
  private foldOver(working: FormValues, locale: string, journey: KernelFoldJourney | undefined): KernelFoldResult {
    // The fold resolves every node once per pass, each over the same view, and reads each
    // `requiredWhen` over the settled one: one context per view rather than one per node.
    let contextFor: Record<string, unknown> | undefined;
    let context: SemanticResolutionContext | undefined;
    const contextOver = (idValues: Record<string, unknown>, pathValues: Record<string, unknown>): SemanticResolutionContext => {
      if (context === undefined || contextFor !== idValues) {
        contextFor = idValues;
        context = this.contextOver(idValues, pathValues, locale);
      }
      return context;
    };
    return kernelFoldSubmittable({
      order: this.foldOrder,
      nodeById: this.foldNodeById,
      parentOf: this.foldParentOf,
      values: working,
      pathOf: this.foldPathOf,
      idsByPath: this.foldIdsByPath,
      collectionOwners: this.foldCollectionOwners,
      defines: this.foldDefines,
      resolve: (node, idValues, pathValues) => {
        this.evaluating = "rules:" + node.id;
        return this.resolver.resolve(node, contextOver(idValues, pathValues));
      },
      // Only called for a node with the rule; with the host context, unlike the
      // kernel. A rule scoped to the server is no rule here.
      ruleRequired: (node, idValues, pathValues) => {
        const rule = this.ruleOf(node.rules, "requiredWhen");
        if (!rule) {
          return false;
        }
        this.evaluating = "rules:" + node.id + ":requiredWhen";
        return evaluateExpression(rule, ruleContext(node, contextOver(idValues, pathValues))) === true;
      },
      // A field's own check, where the fold reads it, with the host context. A rule
      // scoped to the server is no rule here: it holds. Only a yes-or-no `true` holds; a rule
      // whose function threw reads `undefined` and so does not (fail closed).
      ruleValid: (node, idValues, pathValues) => {
        const rule = this.ruleOf(node.rules, "validWhen");
        if (!rule) {
          return true;
        }
        this.evaluating = "rules:" + node.id + ":validWhen";
        return evaluateExpression(rule, ruleContext(node, contextOver(idValues, pathValues))) === true;
      },
      // A data grid's bound formulas, read form-scoped over the settled view as
      // `requiredWhen` is; the fold never asks for one reading `row.`. Only for a form that has
      // one, so every other form folds as it always did. A rule scoped to the server is no rule here.
      ...(this.hasRowBoundRules
        ? {
            ruleRowBound: (node: ComponentNode, key: "minRows" | "maxRows", idValues: Record<string, unknown>, pathValues: Record<string, unknown>): unknown => {
              const rule = this.ruleOf(node.rules, key);
              if (!rule) {
                return undefined;
              }
              this.evaluating = "rules:" + node.id + ":" + key;
              return evaluateExpression(rule, ruleContext(node, contextOver(idValues, pathValues)));
            }
          }
        : {}),
      ...(journey !== undefined ? { journey } : {}),
      ...(this.today !== undefined ? { today: this.today } : {})
    });
  }

  /**
   * Each data grid's row-count bounds as of the last recompute: its fixed
   * `minRows` / `maxRows` with its `rules.minRows` / `rules.maxRows` laid over them where they
   * came to a whole number (`resolveDataGridRowBounds`). Grid id -> bounds, every grid of the
   * form listed, no prototype. What the renderer disables Add and Remove at, what the runtime
   * refuses an Add past, and what the field-constraints stage counts the rows against.
   */
  public dataGridRowBounds(): Record<string, { minRows: number; maxRows: number | undefined }> {
    const out = Object.create(null) as Record<string, { minRows: number; maxRows: number | undefined }>;
    for (const node of this.gridNodes) {
      const read = this.lastRowBounds !== undefined ? kernelOwn(this.lastRowBounds, node.id) : undefined;
      out[node.id] = resolveDataGridRowBounds(dataGridSettingsOf(node), read ?? {});
    }
    return out;
  }

  /** Whether the form defines a value key: the sandbox's allowlist (`kernelDefinesKey`), asked once per key. */
  /**
   * Replaces what `host.` reads (the page's `hostContext`), for the next recompute: every rule,
   * calculation and worked-out value reads the new values from then on. The caller recomputes.
   */
  public setHostContext(hostContext: Record<string, unknown> | undefined): void {
    this.hostContext = hostContext ?? {};
  }

  public definesKey(key: string): boolean {
    return this.foldDefines(key);
  }

  /**
   * Whether a value key is a presentation's own answer: it starts with `@` and the
   * form does not define it. Whatever journey runs, or none: an own answer left by a
   * presentation the person is no longer in is as far from the form pipeline as a live one.
   *
   * `presentation.ts`'s `isPresentationKey` with this form's `defines`, spelt here:
   * every form's answers pass through it, and the presentation module loads with the journey
   * engine. `tests/journey-engine.test.ts` pins the two to the same answers.
   */
  public isPresentationKey(key: string): boolean {
    return key.startsWith("@") && !this.foldDefines(key);
  }

  /**
   * The form values of a set of stored answers: a copy without the keys a
   * presentation's own fields live under. What every calculation, rule, journey condition,
   * validation stage and submission reads.
   */
  /**
   * The answers the form pipeline reads in a recompute: `values` itself when it holds no
   * presentation key and the pipeline writes nothing into it (`mutable` false), else
   * {@link formValues}'s copy.
   */
  private workingValues(values: FormValues, mutable: boolean): FormValues {
    if (!mutable) {
      for (const key of Object.keys(values)) {
        if (this.isPresentationKey(key)) {
          return this.formValues(values);
        }
      }
      return values;
    }
    return this.formValues(values);
  }

  /** Whether any node holds a calculation or a default this side applies (what {@link runValueRules} would write). */
  private hasValueRules(): boolean {
    for (const node of this.nodesInOrder) {
      if ((this.ruleOf(node.rules, "value") || this.ruleOf(node.rules, "defaultValue")) && kernelClaimsData(node)) {
        return true;
      }
    }
    return false;
  }

  public formValues(values: FormValues): FormValues {
    const out: FormValues = {};
    for (const key of Object.keys(values)) {
      if (!this.isPresentationKey(key)) {
        out[key] = values[key];
      }
    }
    return out;
  }

  public effectiveStates(): ReadonlyMap<string, EffectiveNodeState> {
    return this.effective;
  }

  public effectiveStateFor(componentId: string): EffectiveNodeState | undefined {
    return this.views.effectiveFor(componentId);
  }

  /**
   * Whether a component is required as of the last recompute, before the hidden-required
   * policy: `configuration.required` OR its `rules.requiredWhen` holding over the
   * settled view. `false` for the root and for a component the last recompute did not see.
   */
  public isRequired(componentId: string): boolean {
    return this.views.requiredFor(componentId);
  }

  /** {@link isRequired} for every component but the root, in document order. */
  public requiredComponents(): ReadonlyMap<string, boolean> {
    return this.required;
  }

  /**
   * The components whose `rules.validWhen` did not hold over the last recompute's settled view,
   * id -> `true`, in document order, nothing else listed: the fold's `invalid`, what
   * the field-constraints stage reads as `invalidComponents`. A copy; a form without the rule
   * gets an empty record.
   */
  public invalidComponents(): Record<string, boolean> {
    return this.views.invalidRecord();
  }

  /**
   * The one lookup for a node's state, whichever side owns it: a node the running
   * presentation owns from the overlay, first — an own id is never a form component's — else
   * the form component's from the fold. `undefined` for an id neither knows. What decides
   * whether a node shows, is required, and whether an error on it passes the hidden policy.
   */
  public stateOf(id: string): MergedNodeState | undefined {
    const own = this.overlay !== undefined ? kernelOwn(this.overlay, id) : undefined;
    if (own !== undefined) {
      return { effective: own.effective, required: own.required, own };
    }
    const effective = this.views.effectiveFor(id);
    return effective !== undefined ? { effective, required: this.views.requiredFor(id) } : undefined;
  }

  /** The overlay's state of a node the running presentation owns; `undefined` for any other id. */
  public presentationStateOf(id: string): PresentationNodeState | undefined {
    return this.overlay !== undefined ? kernelOwn(this.overlay, id) : undefined;
  }

  /**
   * {@link effectiveStates} with the running presentation's own nodes after the form's
   * what a renderer reads. The form's own map when no presentation runs.
   */
  public mergedEffectiveStates(): ReadonlyMap<string, EffectiveNodeState> {
    const overlay = this.overlay;
    if (overlay === undefined) {
      return this.effective;
    }
    if (this.mergedEffective === undefined) {
      const merged = new Map(this.effective);
      for (const id of this.overlayOrder) {
        const state = kernelOwn(overlay, id);
        if (state !== undefined) {
          merged.set(id, state.effective);
        }
      }
      this.mergedEffective = merged;
    }
    return this.mergedEffective;
  }

  /** {@link requiredComponents} with the running presentation's own nodes after the form's. */
  public mergedRequiredComponents(): ReadonlyMap<string, boolean> {
    const overlay = this.overlay;
    if (overlay === undefined) {
      return this.required;
    }
    if (this.mergedRequiredMap === undefined) {
      const merged = new Map(this.required);
      for (const id of this.overlayOrder) {
        const state = kernelOwn(overlay, id);
        if (state !== undefined) {
          merged.set(id, state.required);
        }
      }
      this.mergedRequiredMap = merged;
    }
    return this.mergedRequiredMap;
  }

  /**
   * Whether the last recompute's worked-out values settled. False only when which
   * of their sources show kept changing with what they wrote — an own field shown by a rule
   * reading the very field it is summed into, say — after three rounds; the
   * last round's writes stand.
   */
  public lastMappingsSettled(): boolean {
    return this.lastSettled;
  }

  public effectiveValues(): FormValues {
    return { ...this.effectiveValueView };
  }

  /** The submittable view keyed by component id, as the rules read it. */
  public effectiveValuesById(): FormValues {
    return valuesByComponentId(this.effectiveValueView, this.componentIdsByPath);
  }

  /**
   * The component whose answer is stored at a value path — the first in document order,
   * should a hand-written definition give two one place. `undefined` for a path no component
   * owns (a row field, a host extra).
   */
  public componentIdForPath(path: string): string | undefined {
    return this.componentIdsByPath.get(path)?.[0];
  }

  /**
   * The repeating section whose entries — or the data grid whose rows — a value key
   * belongs to, wherever its `collectionPath` or `dataPath`
   * puts them: the whole key as a collection path, else its part before the first
   * `[` (`order.items[0].sku` to the section stored at `order.items`). What the browser's
   * hidden-value policy judges such a key by, after its owner and before its leading segment —
   * the fold's reading (`kernelFoldCollectionOwner`), so both sides leave out the same entries.
   * `undefined` for a key no section holds.
   */
  public collectionOwnerOf(key: string): string | undefined {
    const section = kernelOwn(this.foldCollectionOwners, key);
    if (section !== undefined) {
      return section;
    }
    const bracket = key.indexOf("[");
    return bracket > 0 ? kernelOwn(this.foldCollectionOwners, key.slice(0, bracket)) : undefined;
  }

  /** Where a component's answer is stored. Its own id unless a container or a data key moved it. */
  public valuePathOf(componentId: string): string {
    return this.pathOf(componentId);
  }

  /** The active journey's path from the last recompute; `undefined` without a journey. */
  public lastJourneyTrace(): JourneyTrace | undefined {
    return this.lastTrace;
  }

  /** Where each component stood against that path; `undefined` without a journey. */
  public lastJourneyPlacements(): Readonly<Record<string, JourneyPlacement>> | undefined {
    return this.lastPlacements;
  }

  /**
   * Whether the last recompute's fold settled. False only for rules that keep flipping one
   * another through answers they hide — the fold stops after ten passes and uses the last.
   */
  public lastFoldConverged(): boolean {
    return this.lastConverged;
  }

  /** Whether navigation involving `stepId` is permitted by its `rules.navigationGating`. */
  public navigationAllowed(stepId: string, state: FormState): boolean {
    const node = this.nodesInOrder.find((entry) => entry.id === stepId);
    const gate = node !== undefined ? this.ruleOf(node.rules, "navigationGating") : undefined;
    if (!node || !gate) {
      return true;
    }
    // Asked between recomputes: a fresh day, as the next recompute would read.
    this.today = this.deps.today?.();
    const context = this.buildContext(this.formValues(state.values), state.locale);
    return evaluateExpression(gate, ruleContext(node, context)) === true;
  }

  /** The fields of every section's entries, as the kernel reads them (`kernelRowFields`). */
  private rowFieldsOf(): Record<string, { collection: string; suffix: string }> {
    this.rowFieldMap ??= kernelRowFields(this.tree.getRoot());
    return this.rowFieldMap;
  }

  /** Whether a node is a collection-bound container below the root or sits inside one (the kernel's `inCollection`). */
  private inCollection(componentId: string): boolean {
    if (this.collectionMembers === undefined) {
      const members = new Set<string>();
      for (let at = 0; at < this.nodesInOrder.length; at += 1) {
        const node = this.nodesInOrder[at] as ComponentNode;
        let inside = node.collection !== undefined;
        for (let id = kernelOwn(this.foldParentOf, node.id); !inside && id !== undefined; id = kernelOwn(this.foldParentOf, id)) {
          inside = kernelOwn(this.foldNodeById, id)?.collection !== undefined;
        }
        if (inside) {
          members.add(node.id);
        }
      }
      this.collectionMembers = members;
    }
    return this.collectionMembers.has(componentId);
  }

  /** Where a component's value lives. Its own id unless a container has nested it. */
  private pathOf(componentId: string): string {
    return this.valuePaths.get(componentId) ?? componentId;
  }

  /**
   * The value snapshot re-keyed by component id, for rule evaluation.
   *
   * A rule says `visibleWhen: opt_in`, and must keep saying that whether or not `opt_in` sits
   * inside a data-scoping container or carries a data key — otherwise dropping a field into a
   * container, or keying it, would silently break every rule that mentions it. Keys that belong to no component (collection
   * row paths) pass through untouched.
   */
  private ruleValues(values: FormValues): FormValues {
    if (this.componentIdsByPath.size === 0) {
      return values;
    }
    return valuesByComponentId(values, this.componentIdsByPath);
  }

  private buildContext(values: FormValues, locale: string): SemanticResolutionContext {
    return this.contextOver(this.ruleValues(values), values, locale);
  }

  /** A rule context over one view of the answers, given both ways: by component id and by path. */
  private contextOver(
    byComponentId: Record<string, unknown>,
    values: Record<string, unknown>,
    locale: string
  ): SemanticResolutionContext {
    return {
      values: byComponentId,
      locale,
      hostContext: this.hostContext,
      // Own keys only, as the kernel reads them: a component `constructor` left empty is
      // empty, never `Object.prototype.constructor`.
      valueOf: (componentId) => kernelOwn(values, this.pathOf(componentId)),
      // Nearest first, from the parent map built once at construction (the tree is not edited
      // while a runtime holds it): O(depth), where `tree.ancestorsOf` searched the whole tree
      // for every level.
      ancestorValuesFor: (componentId) => {
        const record: Record<string, unknown> = {};
        for (let id = kernelOwn(this.foldParentOf, componentId); id !== undefined; id = kernelOwn(this.foldParentOf, id)) {
          record[id] = kernelOwn(values, this.pathOf(id));
        }
        return record;
      },
      rule: (rules, key) => this.ruleOf(rules, key),
      warn: this.warnFormula,
      regexCache: this.regexCache,
      ...(this.today !== undefined ? { today: this.today } : {}),
      ...(this.functions !== undefined ? { functions: this.functions } : {})
    };
  }

  /**
   * {@link calculationContext} after `written` paths changed in `working`: the id-keyed answers
   * patched in place for the paths a component owns, else rebuilt whole. The same answers a
   * rebuild would read (`kernelJsonAnswers`, re-keyed by id), without copying every answer again.
   */
  private refreshCalculationContext(context: SemanticResolutionContext, working: FormValues, written: readonly string[]): SemanticResolutionContext {
    const byId = context.values as Record<string, unknown>;
    for (const path of written) {
      const ids = this.componentIdsByPath.size === 0 ? [path] : this.componentIdsByPath.get(path);
      if (ids === undefined || ids.length === 0) {
        return this.calculationContext(working);
      }
      const held = kernelOwn(working, path);
      for (const id of ids) {
        if (held === undefined) {
          delete byId[id];
        } else {
          Object.defineProperty(byId, id, { value: kernelJsonValue(held), enumerable: true, writable: true, configurable: true });
        }
      }
    }
    return context;
  }

  /**
   * What a calculation reads: the answers as the envelope carries them — by id as of
   * the start of the pass, its own and its ancestors' as they stand — so a `NaN` one calculation
   * left reads as `null` in the next, as it does where the kernel works them out again from the
   * JSON a server holds. What each calculation stores is its own result, as it came out.
   */
  private calculationContext(working: FormValues): SemanticResolutionContext {
    const context = this.contextOver(this.ruleValues(kernelJsonAnswers(working)), working, "");
    return {
      ...context,
      valueOf: (componentId) => kernelJsonValue(context.valueOf(componentId)),
      ancestorValuesFor: (componentId) => {
        const record = context.ancestorValuesFor(componentId);
        for (const key of Object.keys(record)) {
          record[key] = kernelJsonValue(record[key]);
        }
        return record;
      }
    };
  }

  /**
   * Puts each calculation after the calculations it reads (the dependency graph's edges), so a
   * chain declared sources-last settles in one or two passes instead of one per link. Document
   * order breaks every tie, and inside a cycle the walk simply stops where it came in, so a
   * cycle keeps its document order. The order only speeds the fixpoint; the bound and the
   * "did not converge" refusal stay as they were.
   */
  private orderBySources(calcNodes: Array<{ node: ComponentNode }>): void {
    const byId = new Map<string, number>();
    calcNodes.forEach((entry, index) => byId.set(entry.node.id, index));
    const done = new Array<boolean>(calcNodes.length).fill(false);
    const order: number[] = [];
    for (let start = 0; start < calcNodes.length; start += 1) {
      if (done[start] === true) {
        continue;
      }
      // Iterative post-order walk: a long chain must not cost call-stack depth.
      done[start] = true;
      const stack: Array<{ index: number; sources: number[]; next: number }> = [{ index: start, sources: this.sourcesOf(calcNodes[start]?.node.id ?? "", byId), next: 0 }];
      for (let top = stack[stack.length - 1]; top !== undefined; top = stack[stack.length - 1]) {
        const source = top.sources[top.next];
        if (source !== undefined) {
          top.next += 1;
          if (done[source] !== true) {
            done[source] = true;
            stack.push({ index: source, sources: this.sourcesOf(calcNodes[source]?.node.id ?? "", byId), next: 0 });
          }
        } else {
          order.push(top.index);
          stack.pop();
        }
      }
    }
    const sorted = order.flatMap((index) => (calcNodes[index] !== undefined ? [calcNodes[index]] : []));
    calcNodes.splice(0, calcNodes.length, ...sorted);
  }

  /** The calculation nodes (by position) that a node's rules read, in document order. */
  private sourcesOf(componentId: string, byId: Map<string, number>): number[] {
    const found: number[] = [];
    for (const read of this.dependencyGraph.dependenciesOf(componentId)) {
      const index = byId.get(read);
      if (index !== undefined) {
        found.push(index);
      }
    }
    return found.sort((a, b) => a - b);
  }

  /**
   * Runs calculation + default rules to a fixpoint, mutating `working` in place. Only on a node
   * that holds data (`kernelClaimsData`, as the kernel's `kernelRecomputeCalculations` reads
   * it): a button, static HTML, an image, a signature or a plain group defines no key, and
   * nothing draws its own value, so a calculation or default on one is not worked out — it
   * would put a key in the submission that a server does not know.
   */
  private runValueRules(working: FormValues, withheld?: ReadonlySet<string>): Array<{ componentId: string; value: unknown }> {
    // The calculations and defaults this side applies (`ruleOf`: a `server` calculation is the
    // kernel's alone), on nodes that hold data.
    const calcNodes: Array<{ node: ComponentNode; value: Expression | undefined; defaultValue: Expression | undefined }> = [];
    for (const node of this.nodesInOrder) {
      const value = this.ruleOf(node.rules, "value");
      const defaultValue = this.ruleOf(node.rules, "defaultValue");
      if ((value || defaultValue) && kernelClaimsData(node)) {
        calcNodes.push({ node, value, defaultValue });
      }
    }
    if (calcNodes.length === 0) {
      return [];
    }
    this.orderBySources(calcNodes);

    const writes = new Map<string, unknown>();
    const maxPasses = calcNodes.length + 1;
    // Calculations inside a repeating section or a data grid are worked out once per entry, at
    // the entry's key, with the entry's answers under `row.` and its place among them:
    // the kernel's per-entry loop (`kernelRecomputeCalculations`), so a line
    // total computes in the browser as it does on the server.
    const rowFields = this.rowFieldsOf();
    const rowCollections = Object.create(null) as Record<string, true>;
    for (const { node } of calcNodes) {
      const rowField = kernelOwn(rowFields, node.id);
      if (rowField !== undefined) {
        rowCollections[rowField.collection] = true;
      }
    }
    const hasRows = Object.keys(rowCollections).length > 0;

    for (let pass = 0; pass <= maxPasses; pass += 1) {
      let changed = false;
      let context = this.calculationContext(working);
      // A write is read by the calculations after it in the same pass (they run sources
      // first), so the context is brought up to date before the next evaluation after a write.
      let stale = false;
      // The paths written since the context was built: only these are patched in (a rebuild
      // after every write made a form of n calculations cost n squared).
      const written: string[] = [];
      // Each section's entries and each entry's answers, as of the start of the pass and after a write.
      const entries = hasRows ? kernelRowIndexes(working, rowCollections) : undefined;
      let rowValues = hasRows ? kernelRowValues(working, rowCollections) : undefined;

      for (const { node, value, defaultValue } of calcNodes) {
        if (stale) {
          context = this.refreshCalculationContext(context, working, written);
          if (hasRows) {
            rowValues = kernelRowValues(working, rowCollections);
          }
          written.length = 0;
          stale = false;
        }
        const rowField = kernelOwn(rowFields, node.id);
        // A node in a section that is no field of its entries (the section itself, one nested
        // under a bracketed path) is worked out on neither side.
        if (rowField === undefined && this.inCollection(node.id)) {
          continue;
        }
        const at = rowField !== undefined ? (kernelOwn(entries ?? {}, rowField.collection) ?? []) : [-1];
        const rowCount = at.length;
        for (let position = 0; position < at.length; position += 1) {
          const entry = at[position] as number;
          // Rules read component ids and write value paths — the same translation the rest of
          // the orchestrator makes, applied to a calculation's own output; in a row, the entry's key.
          const path = rowField !== undefined ? `${rowField.collection}[${entry}]${rowField.suffix}` : this.pathOf(node.id);
          const evaluation = ruleContext(node, context);
          if (rowField !== undefined) {
            evaluation.componentValue = kernelJsonValue(kernelOwn(working, path));
            const byEntry = rowValues !== undefined ? kernelOwn(rowValues, rowField.collection) : undefined;
            evaluation.rowValues = (byEntry !== undefined ? kernelOwn(byEntry, String(entry)) : undefined) ?? {};
            evaluation.rowIndex = position + 1;
            evaluation.rowCount = rowCount;
          }
          if (value) {
            this.evaluating = "rules:" + node.id + ":value";
            const next = evaluateExpression(value, evaluation);
            // Compared as the kernel compares (stable JSON), not by identity: a calculation that
            // returns a fresh list or object each pass (split, selected, sort, pluck, a plugin's
            // object) settles when its content does.
            const held = kernelOwn(working, path);
            if (!Object.is(held, next) && kernelStableStringify(held) !== kernelStableStringify(next)) {
              working[path] = next;
              writes.set(path, next);
              written.push(path);
              changed = true;
              stale = true;
            }
          } else if (defaultValue && kernelOwn(working, path) === undefined && withheld?.has(path) !== true) {
            this.evaluating = "rules:" + node.id + ":defaultValue";
            const next = evaluateExpression(defaultValue, evaluation);
            if (next !== undefined) {
              working[path] = next;
              writes.set(path, next);
              written.push(path);
              changed = true;
              stale = true;
            }
          }
        }
      }

      if (!changed) {
        return [...writes].map(([path, value]) => {
          this.deps.applyComputedValue?.(path, value);
          return { componentId: this.componentIdsByPath.get(path)?.[0] ?? path, value };
        });
      }
    }

    const cycle = this.dependencyGraph.findCalculationCycle();
    throw new Error(
      `Calculation rules did not converge${cycle ? `: cycle ${cycle.join(" -> ")}` : ""}`
    );
  }
}

/**
 * One recompute's per-node views over the fold's records (prototype-free, filled in document
 * order): point reads straight from the record, a Map of the whole built once on first ask.
 */
class FoldViews {
  private effective: Map<string, EffectiveNodeState> | undefined;
  private required: Map<string, boolean> | undefined;

  constructor(
    private readonly effectiveRecord: Record<string, EffectiveNodeState>,
    private readonly requiredRecord: Record<string, boolean>,
    private readonly nodes: readonly ComponentNode[],
    private readonly invalid: Record<string, boolean> = Object.create(null) as Record<string, boolean>
  ) {}

  /** The fold's `invalid` as an ordinary record, for a validation context. */
  public invalidRecord(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const id of Object.keys(this.invalid)) {
      // Defined, not assigned: an id `__proto__` stays a key.
      Object.defineProperty(out, id, { value: this.invalid[id] === true, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  public effectiveFor(id: string): EffectiveNodeState | undefined {
    return kernelOwn(this.effectiveRecord, id) || undefined;
  }

  public requiredFor(id: string): boolean {
    return kernelOwn(this.requiredRecord, id) ?? false;
  }

  /** Every node the fold gave a state, in document order. */
  public effectiveMap(): ReadonlyMap<string, EffectiveNodeState> {
    if (this.effective === undefined) {
      const map = new Map<string, EffectiveNodeState>();
      for (const node of this.nodes) {
        const effective = this.effectiveRecord[node.id];
        if (effective) {
          map.set(node.id, effective);
        }
      }
      this.effective = map;
    }
    return this.effective;
  }

  /** Every component but the root, in document order: the fold's record has no prototype and is filled in `order`. */
  public requiredMap(): ReadonlyMap<string, boolean> {
    if (this.required === undefined) {
      this.required = new Map(Object.entries(this.requiredRecord));
    }
    return this.required;
  }
}

function walkPreOrder(
  node: ComponentNode,
  visit: (node: ComponentNode, parent: ComponentNode | undefined) => void,
  parent?: ComponentNode
): void {
  visit(node, parent);
  if (!node.children) {
    return;
  }
  for (const group of Object.values(node.children)) {
    for (const child of group) {
      walkPreOrder(child, visit, node);
    }
  }
}
