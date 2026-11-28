import type { FormError } from "../../core/errors/form-error.js";
import { kernelRuleExpression, kernelRuleRun } from "../../core/expressions/compile.js";
import type { Expression } from "../../core/expressions/expression.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { FormulaFunctionSignature } from "../../core/expressions/formula-types.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { kernelRulesInventory } from "../../core/expressions/inspect.js";
import { runFormTestScenarios } from "../../core/form-tests/form-test-run.js";
import { kernelParseFormTests } from "../../core/form-tests/form-test-parse.js";
import { readFormTests } from "../../core/form-tests/form-test-read.js";
import type {
  FormTestDriver,
  FormTestGiven,
  FormTestProblem,
  FormTestRefusal,
  FormTestScenario,
  FormTestScenarioResult,
  FormTestSkipReason,
  FormTestSnapshot,
  FormTestSnapshotError,
  FormTestStartError,
  FormTestValue
} from "../../core/form-tests/form-test-types.js";
import type { JourneyTrace } from "../../core/journey/journey-types.js";
import { supportedLocaleCodes } from "../../core/localization/supported-locales.js";
import { layerValidationMessages, readValidationMessages, resolveValidationMessage, type ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import type { DataSourceRuntime } from "../../core/schema/contracts.js";
import { DATA_GRID_ROWS_CAP, normalizeDataGrids, rowOperationsOf } from "../../core/schema/data-grid.js";
import { journeyReviewSettings, readJourneys, type JourneyHostChoice } from "../../core/schema/journey.js";
import type { ComponentNode, FormDefinition } from "../../core/schema/types.js";
import type { EffectiveNodeState } from "../../core/state/effective-state.js";
import type { SubmissionVersionContext } from "../../core/submission/canonical-submission.js";
import { stringifyComponentPath } from "../../core/tree/component-path.js";
import { buildComponentIdsByPath, buildRowKeys, collectionPathOf, valuesByComponentId } from "../../core/tree/data-scope.js";
import { defineDataSources, type DataSourceInputs } from "../../data/host/data-source-set.js";
import { selectPdfLayoutForValues } from "../../render/pdf/pdf-layout-selection.js";
import { evaluateExpression, kernelExprAsBoolean } from "../../rules/evaluator/evaluator.js";
import {
  kernelFlattenRows,
  kernelFormTestServerNotScalar,
  kernelFormTestServerRowNotScalar,
  kernelFormTestServerRowAnswers,
  kernelPartitionValues,
  kernelRowKeyParts
} from "../../validation/wasm/portable-kernel.js";
import { kernelIsEmptyValue } from "../../core/schema/answer-kinds.js";
import { kernelOptionChoiceOf } from "../../validation/wasm/portable-options.js";
import type { CheckValuesResult, FormRuntime } from "./form-runtime.js";

/**
 * The browser runtime's driver for form tests: a scenario's actions played
 * on a headless {@link FormRuntime}, and after each one a {@link FormTestSnapshot} of the facts
 * the runtime already produces — the fold's effective states and requiredness, the settled
 * view, the error store, the journey's view, the envelope. No renderer: the builder, vitest and
 * the CLI each hand it a factory that wires their own pipeline, submission modes, sandbox and
 * journey engine, and it makes one fresh runtime per scenario, so scenarios never share state.
 *
 * What a scenario's givens decide cannot be changed on a built runtime (the day, the host
 * context, the journey it opens as, its data sources), so the driver hands them to the factory
 * as {@link FormTestRuntimeGivens}, ready to spread into `FormRuntimeDependencies`; the locale
 * is set on the built runtime (`setLocale`), as a person switching it would.
 *
 * Where the runtime keeps a fact private (the orchestrator's id-keyed settled view, its
 * path-to-component resolver, the fold's trace and what it withheld) the driver works it out
 * from the public reads with the engine's own helpers (`buildComponentIdsByPath`,
 * `valuesByComponentId`, `buildRowKeys`, `kernelPartitionValues`), the way the runtime does,
 * so the snapshot says what the form says and nothing the driver decided on its own.
 */

/**
 * What a scenario's givens ask of the runtime the factory builds: spread into
 * `FormRuntimeDependencies` as they are. `journey` is always set: `"form"` for `given journey =
 * none`, `"journey"` (the definition's default journey even when it opens as a form)
 * when the scenario names none and the form has one, else the journey's id. `today`,
 * `hostContext` and `dataSources` are present only when a given set them.
 */
export interface FormTestRuntimeGivens {
  journey: JourneyHostChoice;
  today?: string;
  hostContext?: Record<string, unknown>;
  dataSources?: DataSourceRuntime;
}

/** Builds one runtime for one scenario: the caller's wiring, with the givens spread in. */
export type FormTestRuntimeFactory = (definition: FormDefinition, givens: FormTestRuntimeGivens) => FormRuntime;

export interface FormTestRuntimeDriverOptions {
  makeRuntime: FormTestRuntimeFactory;
  /** The submission mode `submit` uses; the factory must register it. Absent: `"submit"`. */
  submitMode?: string;
  /** What `submit` hands `FormRuntime.submit`. Absent: the definition's id and version with placeholder client versions. */
  versionContext?: SubmissionVersionContext;
  /** Plugin formula functions an `expect <formula>` may call, as the factory wired them into the runtime. */
  functions?: Record<string, (args: unknown[]) => unknown>;
  /** The signatures of those functions, so the definition's rules are read with them (beside the built-ins). */
  signatures?: readonly FormulaFunctionSignature[];
  /** The host's word on risky patterns, as the factory gave it to the runtime. */
  riskyPatterns?: "refuse" | "allow";
}

/** Whether an error blocks, as the runtime reads it: any severity but `warning` and `info`. */
function isBlocking(error: { severity?: string | undefined }): boolean {
  return error.severity !== "warning" && error.severity !== "info";
}

/** A record with no prototype: ids, paths and codes are an author's and may spell `__proto__`. */
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function own<T>(from: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(from, key) ? from[key] : undefined;
}

/** The running journey's page as the runtime shows it. */
type RuntimeJourneyView = NonNullable<ReturnType<FormRuntime["journeyView"]>>;

/**
 * Whether an error that blocks stands on the page shown (a component the journey places on
 * it, or on no page), or anywhere without a journey.
 */
function blocksOnPage(errors: readonly FormError[], view: RuntimeJourneyView | undefined): boolean {
  return errors.some((error) => {
    if (!isBlocking(error)) {
      return false;
    }
    if (view === undefined || error.componentId === undefined) {
      return true;
    }
    const page = own(view.pageOf, error.componentId);
    return page === undefined || page === view.pageId;
  });
}

/**
 * The page check behind Continue, with the sandbox: where Continue validates the page
 * (not on an exit page or the last, which neither continue, nor on a deferred page that holds
 * no error that blocks), whether the runtime's dry run of a submit's checks over the page
 * (`checkValues({ page })`) refuses it, as the kernel driver's page check does for an answer
 * outside its options, a server rule or a shape bound. The runtime's own Continue runs only
 * the pipeline, so a page this refuses would otherwise move on. Gives the dry run itself, so
 * the driver can keep the sandbox's errors it found (the runtime stores none of them); absent
 * when the page is not checked at all.
 */
async function pageCheck(form: FormRuntime, view: RuntimeJourneyView): Promise<CheckValuesResult | undefined> {
  if (view.kind === "exit" || view.final) {
    return undefined;
  }
  if (view.validation.continue === "defer" && !blocksOnPage(form.errors(), view)) {
    return undefined;
  }
  return form.checkValues({ page: view.pageId });
}

/** Every node under `root`, root first, in document order. */
function nodesOf(root: ComponentNode): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (node: ComponentNode): void => {
    out.push(node);
    for (const group of Object.values(node.children ?? {})) {
      for (const child of group) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The runtime's way from a value path to its component (`FormRuntime.componentIdForValuePath`,
 * private there), over the same tables: the path's own component, else the repeating section
 * whose entries a prefix names, then the entry field the rest (`[0].qty`) names by its row key.
 */
function pathResolver(root: ComponentNode, nodes: ComponentNode[]): (path: string, named?: boolean) => string | undefined {
  const idsByPath = buildComponentIdsByPath(root);
  const collections = new Map<string, string>();
  const descendants = new Map<string, string[]>();
  for (const node of nodes) {
    const collection = collectionPathOf(node);
    if (collection !== undefined && !collections.has(collection)) {
      collections.set(collection, node.id);
      descendants.set(node.id, nodesOf(node).slice(1).map((child) => child.id));
    }
  }
  const rowKeys = buildRowKeys(root);
  const entryFieldOf = (sectionId: string, rest: string): string | undefined => {
    const match = /^\[\d+\]\.(.+)$/.exec(rest);
    if (!match) {
      return undefined;
    }
    const fields = descendants.get(sectionId) ?? [];
    let key = match[1] as string;
    while (key.length > 0) {
      const found = fields.find((id) => rowKeys.get(id) === key);
      if (found !== undefined) {
        return found;
      }
      const cut = key.lastIndexOf(".");
      if (cut <= 0) {
        return undefined;
      }
      key = key.slice(0, cut);
    }
    return undefined;
  };
  // The fields that live in an entry. `named` (what a scenario writes in an expectation, the
  // judge's lookup) refuses them without their `[n]`: a scenario naming `qty` instead of
  // `items[0].qty` fails as an unknown field rather than reading an answer nobody stores there.
  // The kernel driver's `componentIdOf` answers the same; the driver's own lookups of
  // error paths and givens keep the plain reading.
  // A section or a grid inside an entry is not one of its fields: its rows live at its own
  // collection path (the runtime keeps them there), so `inner` names it as `items` names a
  // section of the form's, as the kernel's row fields leave it out.
  const sectionIds = new Set(collections.values());
  const entryFields = new Set<string>();
  for (const ids of descendants.values()) {
    for (const id of ids) {
      if (!sectionIds.has(id)) {
        entryFields.add(id);
      }
    }
  }
  return (path, named = false) => {
    let at = path;
    while (at.length > 0) {
      const owner = idsByPath.get(at)?.[0] ?? collections.get(at);
      if (owner !== undefined) {
        if (named && at === path && entryFields.has(owner)) {
          return undefined;
        }
        // A remainder that names no entry field is no field: the runtime's own resolver falls back
        // to the section, which would let a typo in a row key read the section.
        return at === path ? owner : entryFieldOf(owner, path.slice(at.length));
      }
      const cut = Math.max(at.lastIndexOf("."), at.lastIndexOf("["));
      if (cut <= 0) {
        return undefined;
      }
      at = at.slice(0, cut);
    }
    return undefined;
  };
}

/**
 * The components whose rules the browser never runs: every one
 * of their parseable rules is `run: "server"` or `"server-secret"` (the inspect op's `run`), so
 * an expectation on them skips here with the reason, the secret one winning. A component with
 * any rule the browser runs is judged: its other facts are the browser's to report.
 */
function unreplayableOf(inventory: ReturnType<typeof kernelRulesInventory>): Record<string, FormTestSkipReason> {
  const runs = new Map<string, string[]>();
  for (const rule of inventory.rules) {
    const list = runs.get(rule.componentId) ?? [];
    list.push(rule.run);
    runs.set(rule.componentId, list);
  }
  const out = record<FormTestSkipReason>();
  for (const [componentId, list] of runs) {
    if (list.every((run) => run === "server" || run === "server-secret")) {
      out[componentId] = list.includes("server-secret") ? "unreplayable.secret" : "unreplayable.server";
    }
  }
  return out;
}

/**
 * The reason the browser cannot say whether a run is accepted, when a rule only the server runs
 * could change it (the kernel side skips the same way): a `requiredWhen` or
 * `validWhen` scoped `server` or `server-secret` that fires over the answers as they stand. A
 * rule that holds is no reason (the verdict stands as the browser has it), so a form with one
 * server-only check is not left without a verdict: `requiredWhen` counts only on an empty answer
 * and `validWhen` only on a non-empty one (the field-constraints check raises neither
 * otherwise); a rule this side cannot read or evaluate counts as firing. A secret rule's reason
 * wins. Judged over the settled, id-keyed view.
 */
function serverVerdictReason(
  nodes: ComponentNode[],
  values: Record<string, unknown>,
  signatures: FormulaFunctionSignature[],
  evaluate: (expression: Expression, values: Record<string, unknown>) => unknown
): FormTestSkipReason | undefined {
  let found: FormTestSkipReason | undefined;
  for (const node of nodes) {
    const rules = node.rules as Record<string, unknown> | undefined;
    if (!rules) {
      continue;
    }
    for (const key of ["requiredWhen", "validWhen"]) {
      const source = rules[key];
      const run = source === undefined ? undefined : kernelRuleRun(source);
      if (run !== "server" && run !== "server-secret") {
        continue;
      }
      const empty = kernelIsEmptyValue(own(values, node.id), node.type);
      if (key === "requiredWhen" ? !empty : empty) {
        continue;
      }
      const expression = kernelRuleExpression(source, kernelParseFormula, signatures);
      let fires = true;
      if (expression !== undefined) {
        try {
          const holds = kernelExprAsBoolean(evaluate(expression, values));
          fires = key === "requiredWhen" ? holds : !holds;
        } catch {
          fires = true;
        }
      }
      if (fires) {
        if (run === "server-secret") {
          return "unreplayable.secret";
        }
        found = "unreplayable.server";
      }
    }
  }
  return found;
}

/** `host.a.b` given as `a.b`: nested records, so a rule's `host.a.b` reads it as `kernelExprReadNested` does. */
function setHostValue(into: Record<string, unknown>, name: string, value: FormTestValue): void {
  const parts = name.split(".");
  let cursor = into;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index] as string;
    const next = own(cursor, part);
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const made = record<unknown>();
      cursor[part] = made;
      cursor = made;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1] as string] = value;
}

/**
 * The first five problems of a `FormulaError`, each as `{ code, where }`, when `error` is one
 * (recognised by name and shape, so the driver needs no value import of the runtime's module);
 * `undefined` for any other error.
 */
function formulaProblemsOf(error: unknown): Array<{ code: string; where: string }> | undefined {
  if (!(error instanceof Error) || error.name !== "FormulaError") {
    return undefined;
  }
  const listed = (error as { problems?: unknown }).problems;
  if (!Array.isArray(listed)) {
    return undefined;
  }
  const out: Array<{ code: string; where: string }> = [];
  for (const problem of listed.slice(0, 5)) {
    const entry = problem as { code?: unknown; where?: unknown };
    out.push({ code: String(entry.code), where: String(entry.where) });
  }
  return out;
}

/** The literal as an option's value: options carry strings (`DataSourceItem.value`). */
function optionValue(value: FormTestValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The driver over one runtime per scenario (see the module comment). Each call of the
 * returned driver's `start` builds a fresh runtime; `runFormTestScenarios` makes a driver per
 * scenario, so a factory of drivers is `() => createFormTestRuntimeDriver(definition, options)`.
 */
export function createFormTestRuntimeDriver(definition: FormDefinition, options: FormTestRuntimeDriverOptions): FormTestDriver {
  const root = normalizeDataGrids(definition.root);
  const nodes = nodesOf(root);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const resolve = pathResolver(root, nodes);
  const idsByPath = buildComponentIdsByPath(root);
  const collectionPaths = [...new Set(nodes.map((node) => collectionPathOf(node)).filter((path): path is string => path !== undefined))];
  // The collections as the kernel's row-key reader takes them (`kernelRowKeyParts`).
  const collectionLists = record<true>();
  for (const path of collectionPaths) {
    collectionLists[path] = true;
  }
  const journeyIds = readJourneys(definition).map((journey) => journey.id);
  const signatures = [...formulaFunctionSignatures(), ...(options.signatures ?? [])];
  // The definition's rules as the inspect op lists them, read once: what reads the clock
  // (component rules, page and route conditions, PDF layouts alike) and which components only
  // the server judges.
  const inventory = kernelRulesInventory(definition, kernelParseFormula, signatures);
  const readsClock = inventory.functionsUsed.includes("today") || inventory.functionsUsed.includes("age");
  const unreplayable = unreplayableOf(inventory);
  const hasLayouts = (() => {
    const pdf = definition.pdf as { layouts?: unknown } | undefined;
    return Array.isArray(pdf?.layouts) && pdf.layouts.length > 0;
  })();
  // The catalogs a field's error is worded from, as the renderer layers them: the field's own
  // messages over its containers' over the form's, each worded for the scenario's locale through
  // the definition's `translations` (the root's are the form's own, every other node's its
  // component's). A scenario may switch locale, so they are worked out on first use per locale, as
  // the kernel driver does.
  const catalogsByLocale = new Map<string, { catalogs: Map<string, ValidationMessageCatalog | undefined>; root: ValidationMessageCatalog | undefined }>();
  const wordedFor = (locale: string) => {
    let worded = catalogsByLocale.get(locale);
    if (worded === undefined) {
      const catalogs = new Map<string, ValidationMessageCatalog | undefined>();
      const sources = { translations: definition.translations };
      const layer = (node: ComponentNode, inherited: ValidationMessageCatalog | undefined): void => {
        const own = readValidationMessages(node.configuration, { ownerId: node === root ? undefined : node.id, locale, sources });
        const layered = layerValidationMessages(own, inherited);
        catalogs.set(node.id, layered);
        for (const group of Object.values(node.children ?? {})) {
          for (const child of group) {
            layer(child, layered);
          }
        }
      };
      layer(root, undefined);
      worded = { catalogs, root: readValidationMessages(root.configuration, { locale, sources }) };
      catalogsByLocale.set(locale, worded);
    }
    return worded;
  };
  const regexCache: Record<string, unknown> = options.riskyPatterns === "allow" ? {} : { refuseRisky: true };

  let runtime: FormRuntime | undefined;
  let today: string | undefined;
  let hostContext: Record<string, unknown> | undefined;
  /** The option values each data source was given (`given options for`), by source id. */
  const optionsBySource = new Map<string, string[]>();
  // What the last `submit` or `check` came to. It stands until the next one, as the kernel
  // driver keeps it, so both sides judge the same verdict;
  // `check` sets no `submitted`, and a move sets no verdict.
  let verdict: "accepted" | "refused" | undefined;
  let submitted: Record<string, unknown> | undefined;
  let withheld: string[] | undefined;
  // The errors the sandbox raised in the last `check`/`continue` dry run that it refused
  // (`checkValues` stores nothing, so `form.errors()` never holds them): what the kernel
  // driver keeps as the errors on show after the same step, so `expect error on province:
  // option.notAllowed` reads alike on both sides. Replaced by every check, continue and submit.
  let dryErrors: FormError[] = [];
  const keepDryRun = (dry: CheckValuesResult | undefined): void => {
    dryErrors = dry !== undefined && dry.refusedBy === "wasm" ? dry.errors : [];
  };

  const live = (): FormRuntime => {
    if (runtime === undefined) {
      throw new Error("The form test driver was asked to act before start");
    }
    return runtime;
  };
  /**
   * The literal as the control would store it. A checkbox group holds one boolean per option
   * (`{ news: true, offers: false }`, the renderer's shape), so the language's list of picked
   * values becomes that record over the group's options (its inline ones, or
   * those a `given options for` gave its source), a picked value outside them ticked too.
   * Every other answer is written as written.
   */
  const storedValue = (path: string, value: FormTestValue): unknown => {
    const id = resolve(path);
    const node = id !== undefined ? nodeById.get(id) : undefined;
    if (node?.type !== "checkboxes" || !Array.isArray(value)) {
      return value;
    }
    const choice = kernelOptionChoiceOf(node);
    const offered = choice?.sourceId !== undefined ? (optionsBySource.get(choice.sourceId) ?? []) : (choice?.options ?? []);
    const picked = value.map((entry) => optionValue(entry));
    // A plain object, as the renderer writes it; defined, so an option `__proto__` is a key.
    const out: Record<string, boolean> = {};
    const tick = (option: string, on: boolean): void => {
      Object.defineProperty(out, option, { value: on, enumerable: true, writable: true, configurable: true });
    };
    for (const option of offered) {
      tick(option, picked.includes(option));
    }
    for (const option of picked) {
      tick(option, true);
    }
    return out;
  };
  // The collections the runtime registers (a node bound to a collection path), by path: what a
  // row action may name. Later nodes overwrite earlier ones, as `registerCollections` does.
  const boundCollections = new Map<string, ComponentNode>();
  for (const node of nodes) {
    const collection = collectionPathOf(node);
    if (node.collection && collection !== undefined) {
      boundCollections.set(collection, node);
    }
  }
  /**
   * Why the form would turn a row action down, as a coded refusal, or `undefined` when it would
   * carry it out. The order is the runtime's: the collection must be one, then the operation
   * allowed, then (adding) the most rows not passed or (removing) the row there. The runtime
   * throws a sentence for each of these; a scenario's report is worded from the code.
   */
  const rowRefusal = (form: FormRuntime, path: string, action: "add" | "remove", index: number | undefined): FormTestRefusal | undefined => {
    const node = boundCollections.get(path);
    if (node === undefined) {
      return { refused: "unknownCollection", params: { path } };
    }
    const operations = rowOperationsOf(node);
    if (action === "add") {
      if (operations.add === false) {
        return { refused: "operations.add", params: { path } };
      }
      const max = own(form.dataGridRowBounds(), node.id)?.maxRows ?? DATA_GRID_ROWS_CAP;
      if (form.rows(path).length + 1 > max) {
        return { refused: "rows.max", params: { path, max } };
      }
      return undefined;
    }
    if (operations.remove === false) {
      return { refused: "operations.remove", params: { path } };
    }
    const count = form.rows(path).length;
    if (index === undefined || index < 0 || index >= count) {
      return { refused: "rowOutOfRange", params: { path, index: index ?? -1, count } };
    }
    return undefined;
  };
  const forgetOutcome = (): void => {
    verdict = undefined;
    submitted = undefined;
    withheld = undefined;
    dryErrors = [];
  };

  /**
   * The value paths the submittable view left out: the answers the form defines and holds a
   * value for (`formValues`, cut to the defined keys by the sandbox's own partition) that the
   * fold's view (`submittableValues`) does not carry, hidden and excluded or off the path.
   * Worked out here because the runtime does not expose the fold's own list.
   */
  const withheldPaths = (form: FormRuntime): string[] => {
    const known = kernelPartitionValues(form.formValues(), root).known;
    const view = form.submittableValues();
    const out: string[] = [];
    for (const key of Object.keys(known)) {
      if (known[key] !== undefined && own(view, key) === undefined) {
        out.push(key);
      }
    }
    return out;
  };

  const snapshotErrors = (form: FormRuntime): FormTestSnapshotError[] => {
    const locale = form.state().locale;
    const entryOf = (error: FormError): FormTestSnapshotError => {
      const path = error.path !== undefined ? stringifyComponentPath(error.path) : undefined;
      const componentId = error.componentId ?? (path !== undefined ? resolve(path) : undefined);
      const worded = wordedFor(locale);
      const catalog = (componentId !== undefined ? worded.catalogs.get(componentId) : undefined) ?? worded.root;
      const entry: FormTestSnapshotError = {
        code: error.code,
        stage: error.stage,
        message: resolveValidationMessage(error, catalog, locale, { translations: definition.translations })
      };
      if (componentId !== undefined) {
        entry.componentId = componentId;
      }
      if (path !== undefined) {
        entry.path = path;
      }
      return entry;
    };
    const entries = form.errors().map(entryOf);
    // The sandbox's errors from the last dry run, those the pipeline's stored errors do not
    // already hold (matched on code, component and path).
    const same = (left: FormTestSnapshotError, right: FormTestSnapshotError): boolean =>
      left.code === right.code && left.componentId === right.componentId && left.path === right.path;
    for (const error of dryErrors) {
      const entry = entryOf(error);
      if (!entries.some((held) => same(held, entry))) {
        entries.push(entry);
      }
    }
    return entries;
  };

  const driver: FormTestDriver = {
    start(givens: FormTestGiven[]) {
      let journey: JourneyHostChoice = journeyIds.length > 0 ? "journey" : undefined;
      let locale: string | undefined;
      today = undefined;
      hostContext = undefined;
      optionsBySource.clear();
      let sources: DataSourceInputs | undefined;
      for (const given of givens) {
        switch (given.key) {
          case "today":
            today = given.value;
            break;
          case "locale": {
            // Checked where it stands among the givens, so the first bad one in source order is
            // the one reported, as the kernel side does; `setLocale` refuses the same locales.
            const offered = supportedLocaleCodes(definition.localization);
            if (offered.length > 0 && !offered.includes(given.value)) {
              return { error: "scenario.badGiven" as FormTestStartError, params: { given: "locale", locale: given.value } };
            }
            locale = given.value;
            break;
          }
          case "journey":
            if (given.value === "none") {
              journey = "form";
            } else if (journeyIds.includes(given.value)) {
              journey = given.value;
            } else {
              return { error: "scenario.unknownJourney" as FormTestStartError, params: { journey: given.value } };
            }
            break;
          case "host":
            hostContext ??= record<unknown>();
            setHostValue(hostContext, given.name, given.value);
            break;
          case "options": {
            // A choice's options come from its data source: the given
            // answers that source's load with these values, each its own label.
            const id = resolve(given.path);
            const node = id !== undefined ? nodeById.get(id) : undefined;
            const sourceId = node !== undefined ? kernelOptionChoiceOf(node)?.sourceId : undefined;
            if (sourceId === undefined) {
              return { error: "scenario.badGiven" as FormTestStartError, params: { given: "options", path: given.path, reason: id === undefined ? "unknownField" : "noSource" } };
            }
            sources ??= record<DataSourceInputs[string]>();
            const offered = given.values.map((value) => optionValue(value));
            optionsBySource.set(sourceId, offered);
            sources[sourceId] = offered.map((value) => ({ value, label: value }));
            break;
          }
        }
      }
      // A form whose rules read the day judges by the day the scenario names, never by today's date.
      if (readsClock && today === undefined) {
        return { error: "scenario.clockUnset" as FormTestStartError };
      }
      const wiring: FormTestRuntimeGivens = { journey };
      if (today !== undefined) {
        wiring.today = today;
      }
      if (hostContext !== undefined) {
        wiring.hostContext = hostContext;
      }
      if (sources !== undefined) {
        wiring.dataSources = defineDataSources(sources);
      }
      forgetOutcome();
      let form: FormRuntime;
      try {
        form = options.makeRuntime(definition, wiring);
      } catch (error) {
        // A definition whose formulas do not compile under the policy in force is refused by
        // the runtime's constructor (`FormulaError`): the scenario ends on it, as the kernel
        // side's does, instead of failing as an action nobody took.
        const problems = formulaProblemsOf(error);
        if (problems === undefined) {
          throw error;
        }
        return { error: "scenario.formulaInvalid" as FormTestStartError, params: { problems } };
      }
      runtime = form;
      // The journey the scenario asked for, whatever the factory did with the choice: none
      // leaves a running one, a named or default one is started when it is not running.
      const view = form.journeyView();
      if (journey === "form") {
        if (view !== undefined) {
          form.leaveJourney();
        }
      } else if (journey !== undefined) {
        const wanted = journey === "journey" ? undefined : journey;
        if (view === undefined || (wanted !== undefined && view.journeyId !== wanted)) {
          form.startJourney(wanted);
        }
      }
      if (locale !== undefined) {
        try {
          form.setLocale(locale);
        } catch {
          return { error: "scenario.badGiven" as FormTestStartError, params: { given: "locale", locale } };
        }
      }
      return undefined;
    },

    set(path, value) {
      const form = live();
      // A list on a field that holds one value: the runtime's write would throw. Refused here as
      // a coded refusal, by the kernel driver's own predicate, so both sides word it alike.
      const target = resolve(path);
      if (kernelFormTestServerNotScalar(target !== undefined ? nodeById.get(target)?.type : undefined, value)) {
        const refusal: FormTestRefusal = { refused: "value.notScalar", params: { path } };
        return refusal;
      }
      // A write past the last row adds rows up to it, as the runtime does; never past the most a
      // person could add (the grid's maximum, else the cap every collection is held to), which the
      // kernel driver refuses alike: a one-line statement must not build thousands of rows.
      const row = kernelRowKeyParts(path, collectionLists);
      if (row !== undefined) {
        const node = boundCollections.get(row.collection);
        const max = (node !== undefined ? own(form.dataGridRowBounds(), node.id)?.maxRows : undefined) ?? DATA_GRID_ROWS_CAP;
        const at = Number(row.digits);
        if (at >= form.rows(row.collection).length && at >= max) {
          const refusal: FormTestRefusal = { refused: "rows.max", params: { path: row.collection, max } };
          return refusal;
        }
      }
      form.setValue(path, storedValue(path, value));
      // The answer settled, as a control left after typing.
      form.commitValue(path);
    },

    clear(path) {
      const form = live();
      // Clearing an answer of a row that is not there adds none (the runtime would make rows up to
      // the index for a write); the kernel side leaves it alone as well.
      const row = kernelRowKeyParts(path, collectionLists);
      if (row !== undefined && Number(row.digits) >= form.rows(row.collection).length) {
        return;
      }
      form.setValue(path, undefined);
      form.commitValue(path);
    },

    addRow(path, values) {
      const form = live();
      // A list in a cell that holds one value: the runtime's add would throw, as its write does.
      // Refused here as a coded refusal, by the kernel driver's own predicate, naming the cell of
      // the row the add would make.
      if (collectionLists[path] === true) {
        const cell = kernelFormTestServerRowNotScalar(path, form.rows(path).length, values, (at) => {
          const target = resolve(at);
          return target !== undefined ? nodeById.get(target)?.type : undefined;
        });
        if (cell !== undefined) {
          const refusal: FormTestRefusal = { refused: "value.notScalar", params: { path: cell } };
          return refusal;
        }
      }
      // The refusals the runtime would throw, as the coded reasons the scenario's report words
      // (checked in the order the runtime checks them).
      const refusal = rowRefusal(form, path, "add", undefined);
      if (refusal !== undefined) {
        return refusal;
      }
      // Each cell as a `set` of it stores it: a list on a checkbox group is the group's record.
      const cells = kernelFormTestServerRowAnswers(path, form.rows(path).length, values, storedValue);
      form.addRow(path, cells === undefined ? {} : (cells as Record<string, unknown>));
      return undefined;
    },

    removeRow(path, index) {
      const form = live();
      const refusal = rowRefusal(form, path, "remove", index);
      if (refusal !== undefined) {
        return refusal;
      }
      form.removeRow(path, index);
      return undefined;
    },

    // Without a journey the moves are no-ops: the next expectation says what happened.
    async continue() {
      const form = live();
      const view = form.journeyView();
      if (view === undefined) {
        return;
      }
      const dry = await pageCheck(form, view);
      keepDryRun(dry);
      if (dry?.refused === true) {
        // Refused as Continue refuses: the page's own errors stored, the person kept on it. The
        // sandbox's errors the dry run found stay on show beside them.
        await form.validate({ page: view.pageId });
        return;
      }
      await form.nextPage();
    },

    async back() {
      const form = live();
      if (form.journeyView() !== undefined) {
        await form.previousPage();
      }
    },

    async goTo(page) {
      const form = live();
      if (form.journeyView() !== undefined) {
        await form.goToPage(page);
      }
    },

    /**
     * A Change link of the Check answers page: the step that asks the answer opens through the
     * runtime with direction `change` (the return target set, as a person's press does). Refused
     * as a coded reason when there is no row to press: not on a Check answers page, the page's
     * Change links off, the answer not one the path asks, or the step not one the person may open.
     */
    async change(path) {
      const form = live();
      const view = form.journeyView();
      if (view === undefined || view.kind !== "review") {
        return { refused: "change.notReview", params: { path } };
      }
      if (!journeyReviewSettings(view.page).change) {
        return { refused: "change.off", params: { path } };
      }
      const id = resolve(path, true);
      const target = id === undefined ? undefined : own(view.pageOf, id);
      if (target === undefined) {
        return { refused: "change.notListed", params: { path } };
      }
      const moved = await form.goToPage(target, { direction: "change" });
      return moved.ok ? undefined : { refused: "change.unreachable", params: { path, page: target } };
    },

    /**
     * The page's check with a journey (what Continue runs, without moving), the form's
     * without; refused while an error that blocks stands on the page (or on the form), or when
     * the runtime's dry run of a submit's checks (`checkValues`, the sandbox included) refuses
     * the page's answers (or the form's): an answer outside its options, a server rule or a
     * shape bound refuses here as on the kernel driver.
     */
    async check() {
      const form = live();
      forgetOutcome();
      const view = form.journeyView();
      const scope = view !== undefined ? { page: view.pageId } : {};
      const errors = await form.validate(scope);
      const dryRun = await form.checkValues(scope);
      keepDryRun(dryRun);
      verdict = blocksOnPage(errors, view) || dryRun.refused ? "refused" : "accepted";
      withheld = withheldPaths(form);
    },

    async submit() {
      const form = live();
      forgetOutcome();
      const versionContext: SubmissionVersionContext = options.versionContext ?? {
        form: { id: definition.id, version: definition.version },
        client: { runtimeVersion: "form-test", rendererVersion: "form-test", schemaVersion: definition.schemaVersion }
      };
      const result = await form.submit(options.submitMode ?? "submit", versionContext);
      verdict = result.accepted ? "accepted" : "refused";
      if (result.accepted && result.canonicalSubmission !== undefined) {
        // The envelope carries each collection as one list; an expectation
        // names an entry's answer at its path (`items[0].qty`), so the record is the flattened
        // one, as the kernel side's is: no list beside the paths, one rule for both sides.
        const flat = kernelFlattenRows(result.canonicalSubmission.submission.values, root).values;
        const out = record<unknown>();
        for (const key of Object.keys(flat)) {
          out[key] = flat[key];
        }
        submitted = out;
      }
      withheld = withheldPaths(form);
    },

    snapshot() {
      const form = live();
      const effective = record<EffectiveNodeState>();
      for (const [id, state] of form.effectiveStatesMap()) {
        effective[id] = state;
      }
      // `requiredMap` is before the hidden-required policy; the snapshot's is after it.
      const required = record<boolean>();
      for (const [id, isRequired] of form.requiredMap()) {
        required[id] = isRequired && own(effective, id)?.requiredApplies !== false;
      }
      const byPath = record<unknown>();
      const view = form.submittableValues();
      // Only the answers the form defines, as the kernel keeps them: an answer written at a key
      // no component owns (a row field's bare key, an author's typo) is no answer on either side.
      const known = kernelPartitionValues(view, root).known;
      for (const key of Object.keys(known)) {
        byPath[key] = known[key];
      }
      const values = record<unknown>();
      const byId = valuesByComponentId(view, idsByPath);
      for (const key of Object.keys(byId)) {
        values[key] = byId[key];
      }
      const rows = record<number>();
      for (const path of collectionPaths) {
        rows[path] = form.rows(path).length;
      }
      const journey = form.journeyView();
      // Every page the journey has, so a page named off the path can be told from a typo.
      const pages = journey !== undefined ? journey.journey.pages.map((page) => page.id) : [];
      const snapshot: FormTestSnapshot = { effective, required, values, byPath, errors: snapshotErrors(form), rows, pages };
      if (journey !== undefined) {
        snapshot.page = journey.pageId;
        // The view carries the path and how it ends, not the walk's decisions (the fold's trace
        // is private to the runtime): none are listed.
        const trace: JourneyTrace = { pages: [...journey.path], end: journey.end, decisions: [] };
        snapshot.trace = trace;
      }
      if (verdict !== undefined) {
        snapshot.verdict = verdict;
      }
      if (submitted !== undefined) {
        snapshot.submitted = submitted;
      }
      if (withheld !== undefined) {
        snapshot.withheld = withheld;
      }
      if (hasLayouts) {
        const pdf = form.pdfConfiguration();
        const chosen = selectPdfLayoutForValues(
          { root: form.formRoot(), pdf },
          view,
          {
            ...(today !== undefined ? { today } : {}),
            ...(options.functions !== undefined ? { functions: options.functions } : {}),
            ...(options.riskyPatterns !== undefined ? { riskyPatterns: options.riskyPatterns } : {})
          }
        );
        if (chosen.layout !== undefined) {
          snapshot.layout = chosen.layout.id;
        }
      }
      if (Object.keys(unreplayable).length > 0) {
        snapshot.unreplayable = unreplayable;
      }
      // A server-only requiredness or validity that fires may change the verdict.
      const verdictReason = serverVerdictReason(nodes, values, signatures, (expression, over) => driver.evaluate(expression, over) as unknown);
      if (verdictReason !== undefined) {
        snapshot.verdictUnreplayable = verdictReason;
      }
      return snapshot;
    },

    // As a rule reads (the orchestrator's rule context): the host context, the day, the
    // plugin functions, the same refusal of risky patterns.
    evaluate(expression, values) {
      return evaluateExpression(expression, {
        values,
        ...(hostContext !== undefined ? { hostContext } : {}),
        ...(today !== undefined ? { today } : {}),
        ...(options.functions !== undefined ? { functions: options.functions } : {}),
        regexCache
      });
    },

    componentIdOf(path) {
      return resolve(path, true);
    },

    typeOf(componentId) {
      return nodeById.get(componentId)?.type;
    },

    dispose() {
      // A runtime holds nothing to release: it is dropped with the driver.
      runtime = undefined;
    }
  };
  return driver;
}

/** Parse problems of one source: the definition's entry by id, or an extra source by its index. */
export interface FormTestSourceProblems {
  source: { kind: "definition"; id: string } | { kind: "extra"; index: number };
  problems: FormTestProblem[];
}

/**
 * Runs a form's tests on the browser runtime: the definition's own scenarios
 * (`readFormTests`) and any extra sources (a `.datum-test` file's text), each source parsed on
 * its own with `kernelParseFormTests`. A source with problems contributes no scenarios, so a
 * half-read block never runs; its problems come first in `problems`, source by source. A name
 * an earlier source already used is a `duplicateName` problem on the later source, which
 * still runs. Every scenario runs on a driver of its own (`runFormTestScenarios`).
 */
export async function runFormTestsOnRuntime(
  definition: FormDefinition,
  makeRuntime: FormTestRuntimeFactory,
  extraSources: string[] = [],
  signatures: readonly FormulaFunctionSignature[] = []
): Promise<{ problems: FormTestSourceProblems[]; results: FormTestScenarioResult[] }> {
  const known = [...formulaFunctionSignatures(), ...signatures];
  const problems: FormTestSourceProblems[] = [];
  const scenarios: FormTestScenario[] = [];
  const sources: Array<{ source: FormTestSourceProblems["source"]; text: string }> = [
    ...readFormTests(definition).map((entry) => ({ source: { kind: "definition" as const, id: entry.id }, text: entry.source })),
    ...extraSources.map((text, index) => ({ source: { kind: "extra" as const, index }, text }))
  ];
  // A name taken by an earlier source. The parser catches a repeat inside one source; across
  // sources it cannot (each is parsed alone), yet results are keyed by name, so a report would
  // not tell the two apart. The later one is reported and still runs: the scenario is fine, its
  // name is the author's to change.
  const taken = new Set<string>();
  for (const { source, text } of sources) {
    const parsed = kernelParseFormTests(text, known);
    if (parsed.problems.length > 0) {
      problems.push({ source, problems: parsed.problems });
      continue;
    }
    const repeated: FormTestProblem[] = [];
    for (const scenario of parsed.scenarios) {
      if (taken.has(scenario.name)) {
        repeated.push({
          code: "duplicateName",
          line: scenario.nameSpan.line,
          start: scenario.nameSpan.start,
          end: scenario.nameSpan.end,
          params: { name: scenario.name }
        });
      }
    }
    for (const scenario of parsed.scenarios) {
      taken.add(scenario.name);
    }
    if (repeated.length > 0) {
      problems.push({ source, problems: repeated });
    }
    scenarios.push(...parsed.scenarios);
  }
  const results = await runFormTestScenarios(scenarios, () => createFormTestRuntimeDriver(definition, { makeRuntime, signatures }));
  return { problems, results };
}
