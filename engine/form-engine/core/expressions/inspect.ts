/**
 * Inspecting a definition for a host: the second entry point of the sandbox program
 * (`__datum_inspect`), beside the per-submission run. A host that serves a definition
 * to a browser has to strip its `server-secret` rules first, and a host that cannot run the
 * engine's TypeScript (the Java, .NET and Python hosts) cannot call
 * `publicDefinition()` for that; nor can it list what a definition's formulas read and call.
 * This module answers three questions over one request shape, the same on every host:
 *
 * - `public`: the definition with every rule the compile honours as `server-secret` removed
 *   ({@link kernelPublicDefinition}, the reading of `kernelStripSecretRules`); journeys and PDF
 *   layouts as written, since no rule there may take a server scope.
 * - `check`: what the compile would report, the policy that applies and the verdict a runtime
 *   would reach under it (`fail` only refuses; `warn` keeps the definition), and the
 *   definition's structure ({@link kernelStructureCheck}): ids, types, data
 *   keys, shapes, journeys, PDF layouts, caps. A structure refusal makes the verdict `fail`
 *   whatever the formula policy says.
 * - `inspect`: a static inventory ({@link kernelRulesInventory}): every component rule with
 *   where it runs, what it reads and what it calls, the functions the whole definition uses,
 *   and the ones no built-in provides, and every value path the kernel reads
 *   ({@link InspectedPath}).
 * - `test`: the form's tests run on the kernel's reading, the
 *   definition's own or a sidecar text, answered as a report. The walk lives with the kernel
 *   (`kernelFormTestOp` in `validation/wasm/portable-kernel.ts`), handed in as an argument as the
 *   path builder is.
 *
 * Kernel-shaped (see `validation/wasm/portable-kernel.ts`): top-level `kernel*` function
 * declarations that reference only each other, the compile module's and standard globals; no
 * module constants, nothing nondeterministic. {@link INSPECT_FUNCTIONS} lists them for the
 * sandbox program. The parser is an argument, as it is for the compile. Trees and expressions
 * are walked with explicit stacks, so a definition of any depth is inspected.
 */
import type { FormulaErrorPolicy, RunScope } from "./expression.js";
import type { ComponentNode, FormDefinition } from "../schema/types.js";
import type { FormulaFunctionSignature, FormulaParseResult, FormulaProblem } from "./formula-types.js";
import {
  kernelCompileDefinition,
  kernelFormulaPolicy,
  kernelIsBrowserOnlyRuleKey,
  kernelIsPlainRecord,
  kernelIsRuleKey,
  kernelProblemRunsOnServer,
  kernelIsSecretRule,
  kernelComponentTooDeep,
  kernelMaxComponentDepth,
  kernelRuleExpression,
  kernelRuleRun,
  kernelStripSecretRules,
  kernelStripSecretSources,
  kernelStripSecretJourney,
  kernelHoldsSecretSource,
  type FormulaParser
} from "./compile.js";
import {
  kernelStructureCheck,
  kernelStructureCollect,
  kernelStructureFinish,
  kernelStructureLimits,
  kernelStructureNewLog,
  kernelStructureSizeGate,
  kernelStructureTypesValid,
  type DefinitionLimits,
  type DefinitionProblem
} from "./definition-structure.js";
import type { FormTestOpReport } from "../form-tests/form-test-types.js";

export type { DefinitionLimits, DefinitionProblem } from "./definition-structure.js";

/** The questions a host may ask of a definition. */
export type InspectOp = "public" | "check" | "inspect" | "test";

/**
 * What crosses into the inspect entry point: the ABI the host speaks, the question, the
 * definition (root, with its journey and PDF configurations when it has them) and, for
 * `check`, the host's formula-error policy over the form's own.
 */
export interface DefinitionInspectRequest {
  abi: string;
  op: InspectOp;
  definition: FormDefinition;
  formulaErrors?: FormulaErrorPolicy;
  /** `check` only: `"allow"` lets a literal `matches` pattern of a catastrophic shape pass; default `"refuse"` (`pattern.risky`). */
  riskyPatterns?: "refuse" | "allow";
  /**
   * `check` only: the component types the host can draw, at most 4,096 names of at most
   * 128 characters (else `invalid_request`). A component of another type is a `component.type.unknown`
   * warning. Absent, no type is judged unknown.
   */
  types?: string[];
  /**
   * `test` only: sidecar test text (one or more `test` blocks), parsed with the
   * program's signatures; absent (or `null`), the definition's own `tests.scenarios` run, one
   * block per entry. At most 256 KiB of UTF-8, else `invalid_request`.
   */
  tests?: string;
}

/** One component rule as the inventory lists it. */
export interface InspectedRule {
  componentId: string;
  /** One of the eleven `ComponentRules` keys (a data grid's `minRows` / `maxRows` among them). */
  key: string;
  /** Where the rule runs: the object form's word, else `both`; a browser-only key is always `browser`. */
  run: RunScope;
  /** The form-scoped paths the rule reads (no `host.`, `row.`, `ancestor.` or `component` prefix), in reading order, each once. */
  reads: string[];
  /** The rule reads a `host.` path somewhere, so a server cannot replay it. */
  readsHost: boolean;
  /** The rule reads the day (`today()`, `age()`) somewhere. */
  readsClock: boolean;
  /** The functions the rule calls, sorted by code unit, each once. */
  functions: string[];
}

/** What `inspect` answers: see {@link kernelRulesInventory}. */
export interface RulesInventory {
  /** Every parseable rule of the form tree's components, in document order. */
  rules: InspectedRule[];
  /** Every function the definition calls anywhere (component rules, journeys, PDF layouts), sorted, each once. */
  functionsUsed: string[];
  /** The functions used that no built-in provides: what a plugin must contribute before the definition evaluates. */
  pluginsNeeded: string[];
}

/**
 * One value path of a definition as the `inspect` op lists it: where a component's
 * data sits, entry indexes left out (`items.sku`, the `path` a run's `index` row carries), built
 * by the kernel's own path construction (`kernelDefinitionPaths` in
 * `validation/wasm/portable-kernel.ts`).
 */
export interface InspectedPath {
  /** The value path, entry indexes left out: data keys, data-scoping containers, a section's collection path (a data grid's among them). */
  path: string;
  /** The component the path is its own. */
  componentId: string;
  /** The component's type (`""` when it has none). */
  type: string;
  /** The engine's `holdsData`: false for a button, static HTML, an image, a signature and a plain group, listed at the path they would have. */
  holdsData: boolean;
  /**
   * The data source the component names (`data.sourceId`) and whether its author declared the
   * answers free (`data.answersFree: true`): a free source's snapshot is not checked,
   * so a host need not send it. Absent when the component names no source.
   */
  source?: { id: string; free: boolean };
  /**
   * On a repeating section, where its entries live; on a component inside one entry, the nearest
   * section's. A data grid is listed as such a section and its fields as an entry's.
   */
  collection?: { collectionPath: string };
}

/** What a runtime would do with the definition under the policy: keep it, keep it and warn, or refuse it. */
export type InspectVerdict = "ok" | "warn" | "fail";

/** Why a request was not answered: the wrong ABI, a request of no usable shape, or components nested past the depth limit. */
export type InspectErrorCode = "abi_mismatch" | "invalid_request" | "definition.tooDeep";

/** The answer to a {@link DefinitionInspectRequest}: one of the three ops' answers, or an error. */
export type DefinitionInspectResponse =
  | { ok: true; op: "public"; definition: FormDefinition }
  | {
      ok: true;
      op: "check";
      problems: FormulaProblem[];
      /** Findings that never refuse a run (`condition.notBoolean`), secret rules redacted like `problems`. */
      warnings: FormulaProblem[];
      policy: FormulaErrorPolicy;
      /** Structure refusals: any entry makes the verdict `fail`, under every formula policy. */
      structure: DefinitionProblem[];
      /** Structure findings that never refuse. */
      structureWarnings: DefinitionProblem[];
      /** The caps in force, so a host can hold its own copies to the program's. */
      limits: DefinitionLimits;
      verdict: InspectVerdict;
    }
  | {
      ok: true;
      op: "inspect";
      rules: InspectedRule[];
      functionsUsed: string[];
      pluginsNeeded: string[];
      /** Every value path the kernel reads for the definition, in document order; see {@link InspectedPath}. */
      paths: InspectedPath[];
    }
  | {
      ok: true;
      op: "test";
      /** Every scenario that parsed with its steps, the counts by status and every parse problem. */
      report: FormTestOpReport;
    }
  | { ok: false; error: { code: InspectErrorCode; message: string; where?: string; limit?: number } };

/**
 * The sandbox ABI this entry point answers. Kept here as a literal because the kernel cannot
 * read `WASM_ABI_VERSION` (a module constant, never spliced); `tests/inspect.test.ts` pins the
 * two to the same string, so a bump changes both.
 */
export function kernelInspectAbi(): string {
  return "1.0.0";
}

/**
 * Whether a request's `abi` is one this program answers: a `major.minor.patch` string of the
 * program's own major and no newer than the program's own version. A host's request names the
 * ABI it needs, so a program that does not answer it (another major, or a version above its own)
 * is refused before anything is read.
 */
export function kernelInspectAbiAccepts(requested: unknown, provided: string): boolean {
  if (typeof requested !== "string") {
    return false;
  }
  const want = /^(\d+)\.(\d+)\.(\d+)$/.exec(requested);
  const have = /^(\d+)\.(\d+)\.(\d+)$/.exec(provided);
  if (want === null || have === null) {
    return false;
  }
  return want[1] === have[1] && parseInt(want[2] as string, 10) <= parseInt(have[2] as string, 10);
}

/**
 * The definition a host serves to a browser: the root without the rules the compile honours
 * as `server-secret`, and every value marked `server-secret` in the journeys and PDF
 * layouts, where no server scope is allowed. The kernel-shaped twin of `publicDefinition` in
 * `compile.ts`; the same reading.
 */
export function kernelPublicDefinition(definition: FormDefinition): FormDefinition {
  const copy: Record<string, unknown> = { ...definition, root: kernelStripSecretRules(definition.root) };
  if (definition.journey !== undefined) {
    copy.journey = kernelStripSecretJourney(definition.journey);
  }
  if (definition.pdf !== undefined) {
    copy.pdf = kernelStripSecretSources(definition.pdf);
  }
  // The form's tests are the author's; the twin of the same line in
  // `publicDefinition`, so no sandbox host serves them to a browser.
  delete copy.tests;
  return copy as unknown as FormDefinition;
}

/**
 * Every record node of a component tree in document order (parents before children, slots in
 * stored key order, lists in order), walked with an explicit stack. A node that is not a
 * record, and a slot that is not a list, is skipped.
 */
export function kernelInspectTreeNodes(root: unknown): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!kernelIsPlainRecord(node)) {
      continue;
    }
    nodes.push(node);
    if (!kernelIsPlainRecord(node.children)) {
      continue;
    }
    const pending: unknown[] = [];
    for (const slot of Object.keys(node.children)) {
      const list = node.children[slot];
      if (!Array.isArray(list)) {
        continue;
      }
      for (let index = 0; index < list.length; index += 1) {
        pending.push(list[index]);
      }
    }
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      stack.push(pending[p]);
    }
  }
  return nodes;
}

/**
 * `problems` with the text taken out of every one that sits on a `server-secret` rule:
 * the formula text, its span, the parameters and the message all quote it (a token, a function
 * name), and a rule the author marked secret is secret even when it does not parse. What stays is
 * `where` and `code`, so an operator still sees which rule has a problem and of what kind, and a
 * fixed sentence in place of the message. A problem anywhere else, and one on a rule that is not
 * secret, is returned as it was. A problem is on a secret rule when `where` is `rules:<id>:<key>`
 * and the component `<id>` holds that key as a rule the compile honours as `server-secret`
 * ({@link kernelIsSecretRule}); and, when `sectionsHoldSecret` (the journeys or PDF layouts hold a
 * value marked `server-secret`, {@link kernelHoldsSecretSource}), every problem at a `journey:` or
 * `pdf:` site. A new list; the problems given are not changed.
 */
export function kernelRedactSecretProblems(problems: FormulaProblem[], root: unknown, sectionsHoldSecret?: boolean): FormulaProblem[] {
  const secret: Record<string, boolean> = {};
  const nodes = kernelInspectTreeNodes(root);
  for (let n = 0; n < nodes.length; n += 1) {
    const node = nodes[n] as Record<string, unknown>;
    if (typeof node.id !== "string" || !kernelIsPlainRecord(node.rules)) {
      continue;
    }
    const rules = node.rules;
    const keys = Object.keys(rules);
    for (let k = 0; k < keys.length; k += 1) {
      if (kernelIsSecretRule(keys[k] as string, rules[keys[k] as string])) {
        secret[JSON.stringify([node.id, keys[k]])] = true;
      }
    }
  }
  const redacted: FormulaProblem[] = [];
  for (let p = 0; p < problems.length; p += 1) {
    const problem = problems[p] as FormulaProblem;
    const where = problem.where;
    const cut = typeof where === "string" ? where.lastIndexOf(":") : -1;
    // A secret value written in the journeys or PDF layouts: no rule there may be secret,
    // but the text is, so every problem at a journey or PDF site loses its text.
    const misplaced = sectionsHoldSecret === true && typeof where === "string" && (where.indexOf("journey:") === 0 || where.indexOf("pdf:") === 0);
    if (misplaced || (cut > 6 && where.indexOf("rules:") === 0 && Object.prototype.hasOwnProperty.call(secret, JSON.stringify([where.slice(6, cut), where.slice(cut + 1)])))) {
      redacted.push({ where: problem.where, code: problem.code, message: "The details of this problem are withheld." });
    } else {
      redacted.push(problem);
    }
  }
  return redacted;
}

/**
 * The paths an expression reads and the functions it calls, each list in reading order with
 * repeats kept: the same reading as the evaluator's `kernelExprReadPaths`, `kernelExprReadsHost`
 * and `kernelExprReadsClock` (both sides of `and`/`or`, every branch of an `if`), walked with
 * an explicit stack. A node of no known kind contributes nothing.
 */
export function kernelExprInventory(expression: unknown): { paths: string[]; names: string[] } {
  const paths: string[] = [];
  const names: string[] = [];
  const stack: unknown[] = [expression];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!kernelIsPlainRecord(node)) {
      continue;
    }
    const next: unknown[] = [];
    switch (node.kind) {
      case "path":
        if (typeof node.path === "string") {
          paths.push(node.path);
        }
        break;
      case "unary":
        next.push(node.operand);
        break;
      case "binary":
      case "logical":
      case "arithmetic":
        next.push(node.left, node.right);
        break;
      case "call":
        if (typeof node.name === "string") {
          names.push(node.name);
        }
        if (Array.isArray(node.args)) {
          for (let a = 0; a < node.args.length; a += 1) {
            next.push(node.args[a]);
          }
        }
        break;
      case "if":
        if (Array.isArray(node.cases)) {
          for (let c = 0; c < node.cases.length; c += 1) {
            const entry: unknown = node.cases[c];
            if (kernelIsPlainRecord(entry)) {
              next.push(entry.when, entry.then);
            }
          }
        }
        if (node.else !== undefined) {
          next.push(node.else);
        }
        break;
      default:
        break;
    }
    for (let n = next.length - 1; n >= 0; n -= 1) {
      stack.push(next[n]);
    }
  }
  return { paths, names };
}

/** Whether a read path is form-scoped: no `host.`, `row.`, `ancestor.` or `component` prefix. */
export function kernelInspectIsFormPath(path: string): boolean {
  if (path.startsWith("host.") || path.startsWith("row.") || path.startsWith("ancestor.")) {
    return false;
  }
  return path !== "component" && !path.startsWith("component.");
}

/** Appends each of `names` to `into` once, keeping first-seen order. */
export function kernelInspectAddUnique(into: string[], names: string[]): void {
  for (let n = 0; n < names.length; n += 1) {
    const name = names[n] as string;
    if (into.indexOf(name) < 0) {
      into.push(name);
    }
  }
}

/**
 * The parse the inventory reads through: the host's parser, retried with each unknown function
 * accepted by name (any argument count) until the formula parses or fails for another reason.
 * The inventory exists to say which functions a definition needs, so a call to a function no
 * plugin here provides must still be read; `check` parses strictly and reports it.
 */
export function kernelInspectParse(text: string, signatures: FormulaFunctionSignature[], parse: FormulaParser): FormulaParseResult {
  let known = signatures;
  const added: string[] = [];
  let parsed = parse(text, known);
  // Each round accepts one more name, so the loop ends with the formula's distinct names; the
  // cap is a guard against a parser that keeps naming the same function.
  while (!parsed.ok && parsed.code === "unknownFunction" && added.length < 1000) {
    const name = parsed.params.name;
    if (typeof name !== "string" || added.indexOf(name) >= 0) {
      break;
    }
    added.push(name);
    known = known.concat([{ name, min: 0, max: Infinity }]);
    parsed = parse(text, known);
  }
  return parsed;
}

/**
 * Every function name a call written as JSON in the definition carries (a record with `kind`
 * `"call"` and a string `name`, wherever it stands: a component's rules, a journey, a PDF layout)
 * that `signatures` lacks, each once, in reading order, as a signature taking any number of
 * arguments. A record that only looks like a call (inside a literal) adds a name nothing calls,
 * which changes nothing. Explicit stack.
 */
export function kernelInspectWrittenCallNames(definition: FormDefinition, signatures: FormulaFunctionSignature[]): FormulaFunctionSignature[] {
  const seen = Object.create(null) as Record<string, boolean>;
  for (let s = 0; s < signatures.length; s += 1) {
    const signature = signatures[s] as unknown;
    if (kernelIsPlainRecord(signature) && typeof signature.name === "string") {
      seen[signature.name] = true;
    }
  }
  const added: FormulaFunctionSignature[] = [];
  const stack: unknown[] = [definition.pdf, definition.journey, definition.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push(node[i]);
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "call" && typeof record.name === "string" && seen[record.name] !== true) {
      seen[record.name] = true;
      added.push({ name: record.name, min: 0, max: Infinity });
    }
    const keys = Object.keys(record);
    for (let k = keys.length - 1; k >= 0; k -= 1) {
      stack.push(record[keys[k] as string]);
    }
  }
  return added;
}

/**
 * The static inventory of a definition's formulas. The definition is compiled into a copy
 * through {@link kernelInspectParse} (a formula calling an unknown function still counts; one
 * that fails otherwise is absent, as it is at run time) and read in document order:
 * - `rules`: every rule of the form tree's components under the eleven `ComponentRules` keys
 *   (a data grid's `minRows` / `maxRows` listed as a `requiredWhen` is),
 *   with its run scope (a browser-only key is `browser` whatever it says), its form-scoped
 *   reads in reading order, whether it reads `host.` or the clock, and the functions it calls.
 * - `functionsUsed`: the functions called anywhere, sorted by code unit, each once: the
 *   component rules, then each journey's own-node rules, worked-out values and routes, then each PDF layout's condition and expression sources.
 * - `pluginsNeeded`: `functionsUsed` without the built-ins (`builtins`, the host's list of the
 *   function table's names; absent, the names the `signatures` carry stand in for it).
 */
export function kernelRulesInventory(
  definition: FormDefinition,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  builtins?: string[]
): RulesInventory {
  const lenient: FormulaParser = function (text: string, known: FormulaFunctionSignature[]): FormulaParseResult {
    return kernelInspectParse(text, known, parse);
  };
  // A tree is not parsed, so the lenient parser cannot accept the unknown names it calls, and
  // the compile would drop a tree calling one. Every name a call written as JSON carries is
  // known here (any argument count), so one compile reads every rule, as a formula calling an
  // unknown name is read.
  const known = signatures.concat(kernelInspectWrittenCallNames(definition, signatures));
  const compiled = kernelCompileDefinition(definition.root, definition.journey, definition.pdf, lenient, known).definition;
  const rules: InspectedRule[] = [];
  const used: string[] = [];

  const nodes = kernelInspectTreeNodes(compiled.root);
  for (let n = 0; n < nodes.length; n += 1) {
    const node = nodes[n] as Record<string, unknown>;
    if (!kernelIsPlainRecord(node.rules)) {
      continue;
    }
    const componentId = typeof node.id === "string" ? node.id : "";
    for (const key of Object.keys(node.rules)) {
      if (!kernelIsRuleKey(key)) {
        continue;
      }
      const source = node.rules[key];
      const expression = kernelRuleExpression(source, lenient, signatures);
      if (expression === undefined) {
        continue;
      }
      const inventory = kernelExprInventory(expression);
      const reads: string[] = [];
      let readsHost = false;
      for (let p = 0; p < inventory.paths.length; p += 1) {
        const path = inventory.paths[p] as string;
        if (path.startsWith("host.")) {
          readsHost = true;
        }
        if (kernelInspectIsFormPath(path) && reads.indexOf(path) < 0) {
          reads.push(path);
        }
      }
      const functions: string[] = [];
      kernelInspectAddUnique(functions, inventory.names);
      functions.sort();
      kernelInspectAddUnique(used, inventory.names);
      rules.push({
        componentId,
        key,
        run: kernelIsBrowserOnlyRuleKey(key) ? "browser" : kernelRuleRun(source),
        reads,
        readsHost,
        readsClock: inventory.names.indexOf("today") >= 0 || inventory.names.indexOf("age") >= 0,
        functions
      });
    }
  }

  const journey = compiled.journey;
  if (kernelIsPlainRecord(journey) && Array.isArray(journey.journeys)) {
    for (let j = 0; j < journey.journeys.length; j += 1) {
      const one: unknown = journey.journeys[j];
      if (!kernelIsPlainRecord(one) || !Array.isArray(one.pages)) {
        continue;
      }
      for (let p = 0; p < one.pages.length; p += 1) {
        const page: unknown = one.pages[p];
        if (!kernelIsPlainRecord(page)) {
          continue;
        }
        if (Array.isArray(page.components)) {
          for (let e = 0; e < page.components.length; e += 1) {
            const own = kernelInspectTreeNodes(page.components[e]);
            for (let o = 0; o < own.length; o += 1) {
              const node = own[o] as Record<string, unknown>;
              if (node.type === "journey-value" && kernelIsPlainRecord(node.configuration)) {
                kernelInspectAddUnique(used, kernelExprInventory(kernelRuleExpression(node.configuration.value, lenient, signatures)).names);
              }
              if (!kernelIsPlainRecord(node.rules)) {
                continue;
              }
              for (const key of Object.keys(node.rules)) {
                if (kernelIsRuleKey(key)) {
                  kernelInspectAddUnique(used, kernelExprInventory(kernelRuleExpression(node.rules[key], lenient, signatures)).names);
                }
              }
            }
          }
        }
        if (Array.isArray(page.routes)) {
          for (let r = 0; r < page.routes.length; r += 1) {
            const route: unknown = page.routes[r];
            if (kernelIsPlainRecord(route)) {
              kernelInspectAddUnique(used, kernelExprInventory(kernelRuleExpression(route.when, lenient, signatures)).names);
            }
          }
        }
      }
    }
  }

  const pdf = compiled.pdf;
  if (kernelIsPlainRecord(pdf) && Array.isArray(pdf.layouts)) {
    for (let l = 0; l < pdf.layouts.length; l += 1) {
      const layout: unknown = pdf.layouts[l];
      if (!kernelIsPlainRecord(layout)) {
        continue;
      }
      kernelInspectAddUnique(used, kernelExprInventory(kernelRuleExpression(layout.when, lenient, signatures)).names);
      const bindings: unknown[] = [];
      if (Array.isArray(layout.fields)) {
        for (let f = 0; f < layout.fields.length; f += 1) {
          bindings.push(layout.fields[f]);
        }
      }
      if (Array.isArray(layout.areas)) {
        for (let a = 0; a < layout.areas.length; a += 1) {
          bindings.push(layout.areas[a]);
        }
      }
      for (let b = 0; b < bindings.length; b += 1) {
        const binding = bindings[b];
        if (kernelIsPlainRecord(binding) && kernelIsPlainRecord(binding.source) && binding.source.kind === "expression") {
          kernelInspectAddUnique(used, kernelExprInventory(kernelRuleExpression(binding.source.expression, lenient, signatures)).names);
        }
      }
    }
  }

  const functionsUsed = used.slice();
  functionsUsed.sort();
  const provided: string[] = [];
  if (Array.isArray(builtins)) {
    kernelInspectAddUnique(provided, builtins);
  } else {
    for (let s = 0; s < signatures.length; s += 1) {
      provided.push((signatures[s] as FormulaFunctionSignature).name);
    }
  }
  const pluginsNeeded: string[] = [];
  for (let u = 0; u < functionsUsed.length; u += 1) {
    const name = functionsUsed[u] as string;
    if (provided.indexOf(name) < 0) {
      pluginsNeeded.push(name);
    }
  }
  return { rules, functionsUsed, pluginsNeeded };
}

/** An error answer, for the shape checks; `where` and `limit` are for `definition.tooDeep`. */
export function kernelInspectError(code: InspectErrorCode, message: string, where?: string, limit?: number): DefinitionInspectResponse {
  const error: { code: InspectErrorCode; message: string; where?: string; limit?: number } = { code, message };
  if (where !== undefined) {
    error.where = where;
  }
  if (limit !== undefined) {
    error.limit = limit;
  }
  return { ok: false, error };
}

/**
 * The size pass `check` runs first, alone: the form tree collected
 * up to the component cap and the caps counted, as {@link kernelStructureCheck} does before any
 * other read. Returns the size problems (the same ones, in the same order, that the structure
 * check answers for a gated definition), or `undefined` when no cap is passed. The `test` op
 * needs no more: the whole check would read every rule, the languages, the journeys and the PDF
 * only for the op to throw those results away.
 */
export function kernelInspectSizeGate(definition: Record<string, unknown>): DefinitionProblem[] | undefined {
  const log = kernelStructureNewLog();
  const entries = kernelStructureCollect(definition.root, kernelStructureLimits().components + 2);
  const gate = kernelStructureSizeGate(definition, entries, log);
  if (!gate.exceeded) {
    return undefined;
  }
  kernelStructureFinish(log);
  return log.structure;
}

/**
 * The `test` op's refusal of a definition past a size cap:
 * `invalid_request` at `where: "definition"`, the first cap the structure pass names (its code and
 * sentence in the message, its number as `limit`), so a host reads the same refusal shape the op's
 * own text caps give. The rest of the size problems are `check`'s to list.
 */
export function kernelInspectSizeRefusal(structure: DefinitionProblem[]): DefinitionInspectResponse {
  const first = structure[0];
  if (first === undefined) {
    return kernelInspectError("invalid_request", "The definition is past a size cap, so its tests are not run", "definition");
  }
  return kernelInspectError(
    "invalid_request",
    "The definition is past a size cap, so its tests are not run (" + first.code + (first.message === undefined ? "" : ": " + first.message) + ")",
    "definition",
    first.limit
  );
}

/**
 * Answers one {@link DefinitionInspectRequest}. The request is checked before anything is read:
 * a record, with an `abi` this program accepts ({@link kernelInspectAbiAccepts}; else
 * `abi_mismatch`), one of the three ops and a `definition` record whose `root` is a record
 * (else `invalid_request`). A `formulaErrors` that is not one of the words (`warn`, `fail`) is ignored,
 * as the kernel's run ignores it, and `check` reports the policy that applied. `signatures` is
 * what the parser checks a call against (the built-ins' plus the wired plugins', as for the
 * run); `builtins` names the function table's rows so `inspect` can tell a plugin function
 * from a built-in. `pathsOf` is the kernel's path builder for `inspect`'s `paths`,
 * an argument as the parser is, since this module cannot import the kernel that imports it;
 * the kernel's entry (`kernelRunInspect`) always passes it, and without it `paths` is empty.
 * Pure: the same request answers the same bytes on every host, and the definition handed in
 * is never changed. `isJourney` is the shape the run applies to a journey (`kernelIsJourney`), for `check`'s structure pass, an argument for the same reason; without it a journey
 * needs only a non-empty id and a list of pages. `normalize` is the kernel's
 * `kernelNormalizeDataGrids`, for the same reason: every op reads the definition as
 * the run reads it, every data grid bound to a collection. So the depth is measured over that
 * tree, as the run measures it, and `public` strips the secret rules over it and answers it. `test`
 * is the kernel's `kernelFormTestOp`, an argument for the same reason; it gets the
 * request and the definition as the request carries it (the run binds a grid itself), once
 * the shape and depth checks have passed and the definition is within the size caps `check`
 * gates on first ({@link kernelInspectSizeRefusal} otherwise). Without it `test` is `invalid_request`.
 */
export function kernelInspectDefinition(
  request: unknown,
  parse: FormulaParser,
  signatures: FormulaFunctionSignature[],
  builtins?: string[],
  pathsOf?: (root: FormDefinition["root"]) => InspectedPath[],
  isJourney?: (value: unknown) => boolean,
  normalize?: (root: FormDefinition["root"]) => FormDefinition["root"],
  test?: (request: Record<string, unknown>, definition: FormDefinition) => DefinitionInspectResponse
): DefinitionInspectResponse {
  if (!kernelIsPlainRecord(request)) {
    return kernelInspectError("invalid_request", "The request is a JSON object { abi, op, definition, formulaErrors? }");
  }
  if (!kernelInspectAbiAccepts(request.abi, kernelInspectAbi())) {
    return kernelInspectError(
      "abi_mismatch",
      "This program answers sandbox ABI " + kernelInspectAbi() + "; the request names " + (typeof request.abi === "string" ? request.abi : "no ABI")
    );
  }
  const op = request.op;
  if (op !== "public" && op !== "check" && op !== "inspect" && op !== "test") {
    return kernelInspectError("invalid_request", 'The op is "public", "check", "inspect" or "test"; the request names ' + JSON.stringify(op === undefined ? null : op));
  }
  const definition = request.definition;
  if (!kernelIsPlainRecord(definition) || !kernelIsPlainRecord(definition.root)) {
    return kernelInspectError("invalid_request", "The definition is a form definition object with a root component");
  }
  // The definition as the run reads it: a copy with the normalized root when a grid
  // was bound, every other key as written; the request's own objects are never changed.
  const root = typeof normalize === "function" ? normalize(definition.root as unknown as FormDefinition["root"]) : (definition.root as unknown as FormDefinition["root"]);
  let read: Record<string, unknown> = definition;
  if ((root as unknown) !== definition.root) {
    read = {};
    const keys = Object.keys(definition);
    for (let k = 0; k < keys.length; k += 1) {
      Object.defineProperty(read, keys[k] as string, { value: definition[keys[k] as string], writable: true, enumerable: true, configurable: true });
    }
    read.root = root;
  }
  const deep = kernelComponentTooDeep(root, definition.journey);
  if (deep !== undefined) {
    return kernelInspectError(
      "definition.tooDeep",
      "Components nest more than " + kernelMaxComponentDepth() + " levels deep (at " + deep + "): the validator reads at most " + kernelMaxComponentDepth() + ".",
      deep,
      kernelMaxComponentDepth()
    );
  }
  if (op === "check" && request.types !== undefined && request.types !== null && !kernelStructureTypesValid(request.types)) {
    return kernelInspectError("invalid_request", "The types are a list of at most 4096 component type names of at most 128 characters");
  }
  if (op === "public") {
    return { ok: true, op: "public", definition: kernelPublicDefinition(read as unknown as FormDefinition) };
  }
  if (op === "test") {
    if (typeof test !== "function") {
      return kernelInspectError("invalid_request", "This program does not run form tests");
    }
    // The size gate `check` runs first: the op runs up to 200
    // scenarios, each a whole run, so a definition past a size cap is refused before any of
    // them, and only the host's time budget would bound the work otherwise. The size pass alone:
    // the rest of the structure check would be read only to be thrown away.
    const gated = kernelInspectSizeGate(read);
    if (gated !== undefined) {
      return kernelInspectSizeRefusal(gated);
    }
    return test(request, definition as unknown as FormDefinition);
  }
  const form = read as unknown as FormDefinition;
  if (op === "check") {
    // The structure first: a definition past a size cap is answered with the size
    // problems alone, so nothing below runs over it.
    const found = kernelStructureCheck(read, Array.isArray(request.types) ? (request.types as string[]) : undefined, isJourney);
    if (found.sizeGate) {
      return {
        ok: true,
        op: "check",
        problems: [],
        warnings: [],
        policy: kernelFormulaPolicy(form.root.configuration, request.formulaErrors),
        structure: found.structure,
        structureWarnings: [],
        limits: kernelStructureLimits(),
        verdict: "fail"
      };
    }
    const checked = kernelCompileDefinition(form.root, form.journey, form.pdf, parse, signatures, request.riskyPatterns);
    const misplacedSecret = kernelHoldsSecretSource(form.journey) || kernelHoldsSecretSource(form.pdf);
    const problems = kernelRedactSecretProblems(checked.problems, form.root, misplacedSecret);
    const warnings = kernelRedactSecretProblems(checked.warnings === undefined ? [] : checked.warnings, form.root, misplacedSecret);
    const policy = kernelFormulaPolicy(form.root.configuration, request.formulaErrors);
    let verdict: InspectVerdict = problems.length === 0 ? "ok" : policy === "fail" ? "fail" : "warn";
    if (verdict === "warn") {
      // The kernel refuses, under every word, an unknown function on a rule the server runs,
      // so check says "fail" for that case too.
      const nodeById = Object.create(null) as Record<string, ComponentNode>;
      const nodes = kernelInspectTreeNodes(form.root);
      for (let n = 0; n < nodes.length; n += 1) {
        nodeById[String(nodes[n]!.id)] = nodes[n] as unknown as ComponentNode;
      }
      for (let p = 0; p < problems.length; p += 1) {
        if (problems[p]!.code === "unknownFunction" && kernelProblemRunsOnServer({ nodeById }, problems[p]!.where)) {
          verdict = "fail";
          break;
        }
      }
    }
    if (found.structure.length > 0) {
      verdict = "fail";
    }
    return {
      ok: true,
      op: "check",
      problems,
      warnings,
      policy,
      structure: found.structure,
      structureWarnings: found.structureWarnings,
      limits: kernelStructureLimits(),
      verdict
    };
  }
  const inventory = kernelRulesInventory(form, parse, signatures, builtins);
  const paths = typeof pathsOf === "function" ? pathsOf(form.root) : [];
  return { ok: true, op: "inspect", rules: inventory.rules, functionsUsed: inventory.functionsUsed, pluginsNeeded: inventory.pluginsNeeded, paths };
}

/** This module's kernel functions, for `PORTABLE_KERNEL_FUNCTIONS`. */
export const INSPECT_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelInspectWrittenCallNames,
  kernelInspectAbi,
  kernelInspectAbiAccepts,
  kernelPublicDefinition,
  kernelInspectTreeNodes,
  kernelRedactSecretProblems,
  kernelExprInventory,
  kernelInspectIsFormPath,
  kernelInspectAddUnique,
  kernelInspectParse,
  kernelRulesInventory,
  kernelInspectError,
  kernelInspectSizeGate,
  kernelInspectSizeRefusal,
  kernelInspectDefinition
];
