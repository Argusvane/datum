import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  coerceAnswer,
  coerceRowsAnswer,
  isNestedCollection as answersIsNestedCollection,
  kindOfNode,
  matchOption as answersMatchOption,
  optionsOf as answersOptionsOf,
  unfillableStaticKind as answersUnfillableStaticKind,
  writabilityOf as answersWritabilityOf,
  writabilityOfState,
  type AnswerProblem,
  type AnswerResult,
  type FieldColumn,
  type FieldKind,
  type Writability,
  type WritableState
} from "../form-engine/agent/answers/index.js";
import { coerceRows, coerceScalar, matchOption } from "../form-engine/agent/form/coerce.js";
import { createMemoStore, ensureMemo, isNestedCollection, kindOf, optionsOf, unfillableStaticKind, writabilityOf, type RenderMemo } from "../form-engine/agent/form/describe.js";
import { notWritable, resolveRef, writeGuard } from "../form-engine/agent/form/guards.js";
import { runtimeAgentHost } from "../form-engine/agent/form/host.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { PROVINCES, agentRuntime } from "./fixtures/agent-form.js";

/**
 * The shared answers module. The renderer's coercion,
 * option matching, kinds and writability live in `agent/answers/`, so the builder's Try it tool
 * can read answers the way `set_answers` does without the renderer catalogue in the builder
 * bundle. Their behaviour is held against golden outputs captured from the functions
 * (`fixtures/agent-answers-golden.json`, written by a capture script; the file carries the
 * definitions, the scenarios and every run's inputs, so this test rebuilds them from it alone):
 *
 * - the renderer's wrappers (`coerceScalar`, `coerceRows`, `matchOption`, `writeGuard`, and the
 *   names `describe.ts` re-exports) give the golden results byte for byte, refusal messages and
 *   hints included, key order too (the JSON text is compared, not the parsed objects);
 * - the answers functions (`coerceAnswer`, `coerceRowsAnswer`, `matchOption`, `kindOfNode`,
 *   `writabilityOf`, `writabilityOfState`) give the golden results with the message and the
 *   hint left out: the same code, details, expected and got.
 *
 * The golden runs build the memo and the runtime at one revision, so the memo's `visible`,
 * `disabled` and `readOnly` always equal the effective state there; `writabilityOfState`'s own
 * reading of the fresh `state` and `cell` (the memo lags the runtime until the revision is
 * bumped, and Try it judges from the preview runtime's effective state) is held by its own
 * cases: a memo left behind by `setValue`, and each flag passed alone.
 *
 * And the module stays hint-free and catalogue-free: no import from `agent/form/` or
 * `agent/builder/`, directly or through any chain of imports (the agent barrel re-exports
 * both), no tool name the builder bundle must not spell (guard 15).
 */

type Json = unknown;
type Target = { id: string } | { path: string };

interface Scenario {
  definition: string;
  dataSources: "default" | "none" | "pending" | "failing";
  locale?: string;
  journey?: string;
  rows?: Record<string, number>;
  values?: Record<string, unknown>;
  nextPages?: number;
}

interface Override {
  type?: string;
  value?: unknown;
  file?: unknown;
  visible?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  optionState?: Record<string, unknown>;
}

interface Group {
  fn: "model" | "coerceScalar" | "matchOption" | "coerceRows" | "writeGuard";
  scenario: string;
  target?: Target;
  override?: Override;
  path?: string;
  kind?: FieldKind;
  locale?: string;
  acceptsFreeText?: boolean;
  columns?: Json;
  freeColumns?: string[];
  missingCell?: string;
  context?: { focused: string | null; dataSourcesAllowed: boolean };
  runs: Record<string, Json>[];
}

interface Golden {
  definitions: Record<string, Json>;
  scenarios: Record<string, Scenario>;
  groups: Group[];
}

const GOLDEN_FILE = resolve(__dirname, "fixtures/agent-answers-golden.json");
const golden = JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) as Golden;

// ---- the golden file's encoding (the capture script's, symmetric) ----------------------------------

/** Values JSON cannot hold: undefined, NaN / ±Infinity, a long run of one character. */
function toJson(value: unknown): Json {
  if (value === undefined) {
    return { $undefined: true };
  }
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined) {
        return { $undefined: true };
      }
      if (typeof item === "number" && !Number.isFinite(item)) {
        return { $number: String(item) };
      }
      if (typeof item === "string" && item.length > 1_000 && item === (item[0] as string).repeat(item.length)) {
        return { $repeat: [item[0], item.length] };
      }
      return item;
    })
  ) as Json;
}

function fromJson(value: Json): unknown {
  if (Array.isArray(value)) {
    return value.map(fromJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.$undefined === true) {
      return undefined;
    }
    if (typeof record.$number === "string") {
      return Number(record.$number);
    }
    if (Array.isArray(record.$repeat)) {
      return String(record.$repeat[0]).repeat(Number(record.$repeat[1]));
    }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, fromJson(item)]));
  }
  return value;
}

// ---- scenarios, rebuilt from the file -------------------------------------------------------------

interface Built {
  runtime: FormRuntime;
  memo: RenderMemo;
}

async function build(scenario: Scenario, definition = fromJson(golden.definitions[scenario.definition]) as FormDefinition): Promise<Built> {
  const dataSources =
    scenario.dataSources === "none"
      ? false
      : scenario.dataSources === "pending"
        ? defineDataSources({ provinces: () => new Promise(() => undefined) })
        : scenario.dataSources === "failing"
          ? defineDataSources({
              provinces: () => {
                throw new Error("backend secret");
              }
            })
          : defineDataSources({ provinces: PROVINCES });
  const runtime = agentRuntime(definition, { dataSources, ...(scenario.journey !== undefined ? { journey: scenario.journey } : {}) });
  if (scenario.locale !== undefined) {
    runtime.setLocale(scenario.locale);
  }
  for (const [collection, count] of Object.entries(scenario.rows ?? {})) {
    for (let index = 0; index < count; index += 1) {
      runtime.addRow(collection, {});
    }
  }
  for (const [path, value] of Object.entries(scenario.values ?? {})) {
    runtime.setValue(path, value);
    runtime.commitValue(path);
  }
  for (let index = 0; index < (scenario.nextPages ?? 0); index += 1) {
    await runtime.nextPage();
  }
  const host = runtimeAgentHost(runtime, { journeyKit: EagerJourneyRenderKit });
  // A source that never answers is drawn as loading once the budget runs out (the provisional memo).
  const memo = await ensureMemo(createMemoStore(), host, runtime, 1, scenario.dataSources === "pending" ? 50 : 5_000);
  return { runtime, memo };
}

const built = new Map<string, Built>();

beforeAll(async () => {
  for (const [name, scenario] of Object.entries(golden.scenarios)) {
    built.set(name, await build(scenario));
  }
});

function scenarioOf(name: string): Built {
  const found = built.get(name);
  if (found === undefined) {
    throw new Error(`no scenario ${name}`);
  }
  return found;
}

function modelOf(memo: RenderMemo, target: Target, override?: Override): RenderComponentModel {
  const model = "id" in target ? memo.modelById.get(target.id) : memo.modelByPath.get(target.path);
  if (model === undefined) {
    throw new Error(`no model for ${JSON.stringify(target)}`);
  }
  if (override === undefined) {
    return model;
  }
  const { optionState, ...rest } = fromJson(override) as Override;
  return { ...model, ...rest, ...(optionState !== undefined ? { optionState: { ...model.optionState, ...optionState } } : {}) } as RenderComponentModel;
}

function label(group: Group): string {
  const target = group.target !== undefined ? ` ${JSON.stringify(group.target)}` : "";
  return `${group.scenario}${target}${group.override !== undefined ? " (overridden)" : ""}${group.context !== undefined ? ` ${JSON.stringify(group.context)}` : ""}`;
}

function groupsOf(fn: Group["fn"]): [string, Group][] {
  return golden.groups.filter((group) => group.fn === fn).map((group, index) => [`${index} ${label(group)}`, group]);
}

// ---- the comparisons ------------------------------------------------------------------------------

/**
 * Byte for byte: the JSON text an agent would receive against the golden text. `toEqual` on the
 * parsed objects ignores key order, so a `refusalOf` that put `details` first, or details built
 * in another order, would change what reaches the agent and still pass.
 */
function expectSameJson(actual: unknown, expected: Json, where: string): void {
  expect(JSON.stringify(toJson(actual)), where).toBe(JSON.stringify(expected));
}

interface GoldenRefusal {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, Json>;
}

/** The answers problem against the golden refusal: same code, details, expected and got; no message or hint. */
function expectProblemMatches(problem: AnswerProblem, refusal: GoldenRefusal, where: string): void {
  expect(problem.code, where).toBe(refusal.code);
  expect(toJson(problem.details), where).toEqual(refusal.details);
  expect(problem, where).not.toHaveProperty("message");
  expect(problem, where).not.toHaveProperty("hint");
  const details = refusal.details ?? {};
  expect(problem.path, where).toBe(problem.code === "too-large" ? details.key : details.path);
  if (problem.expected !== undefined || details.expected !== undefined) {
    expect(problem.expected, where).toBe(details.expected);
  }
  if (problem.got !== undefined || (details.got !== undefined && problem.code !== "options-loading" && problem.code !== "options-failed")) {
    expect(toJson(problem.got), where).toEqual(details.got);
  }
}

/** An answers result against the golden `Coerced`: an ok result whole, a problem through {@link expectProblemMatches}. */
function expectAnswerMatches(result: AnswerResult, expected: Json, where: string): void {
  const coerced = expected as { ok: boolean; refusal?: GoldenRefusal };
  if (coerced.ok) {
    expect(toJson(result), where).toEqual(expected);
    return;
  }
  expect(result.ok, where).toBe(false);
  if (!result.ok) {
    expectProblemMatches(result.problem, coerced.refusal as GoldenRefusal, where);
  }
}

// ---- the cases --------------------------------------------------------------------------------------

describe("the golden file", () => {
  it("covers every function the move touched, over every scenario it names", () => {
    const counts: Record<string, number> = {};
    for (const group of golden.groups) {
      counts[group.fn] = (counts[group.fn] ?? 0) + group.runs.length;
    }
    expect(Object.keys(counts).sort()).toEqual(["coerceRows", "coerceScalar", "matchOption", "model", "writeGuard"]);
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(20);
    }
    for (const group of golden.groups) {
      expect(golden.scenarios[group.scenario], group.scenario).toBeDefined();
    }
  });
});

describe("kinds, options and static writability (describe.ts re-exports and agent/answers)", () => {
  it.each(groupsOf("model"))("%s", (_title, group) => {
    const { memo } = scenarioOf(group.scenario);
    for (const run of group.runs) {
      const where = `${label(group)} ${JSON.stringify(run.target)}`;
      const model = modelOf(memo, run.target as Target, run.override as Override | undefined);
      expect(model.valuePath, where).toBe(run.path);
      const kind = kindOf(model);
      const renderer = { kindOf: kind, writabilityOf: writabilityOf(model, kind), optionsOf: optionsOf(model), unfillableStaticKind: unfillableStaticKind(model), isNestedCollection: isNestedCollection(model) };
      expectSameJson(renderer, run.result, where);
      const shared = {
        kindOf: kindOfNode(model),
        writabilityOf: answersWritabilityOf(model, kindOfNode(model)),
        optionsOf: answersOptionsOf(model),
        unfillableStaticKind: answersUnfillableStaticKind(model),
        isNestedCollection: answersIsNestedCollection(model)
      };
      expect(toJson(shared), where).toEqual(run.result);
    }
  });
});

describe("coerceScalar (renderer wording) and coerceAnswer (hint-free)", () => {
  it.each(groupsOf("coerceScalar"))("%s", (_title, group) => {
    const { memo } = scenarioOf(group.scenario);
    const model = modelOf(memo, group.target as Target, group.override);
    const kind = group.kind as FieldKind;
    const options = { locale: group.locale as string, acceptsFreeText: group.acceptsFreeText as boolean };
    for (const run of group.runs) {
      const where = `${label(group)} raw ${JSON.stringify(run.raw).slice(0, 80)}`;
      const raw = fromJson(run.raw);
      expectSameJson(coerceScalar(model, kind, raw, group.path as string, options), run.result, where);
      expectAnswerMatches(coerceAnswer(model, kind, fromJson(run.raw), group.path as string, options), run.result, where);
    }
  });
});

describe("matchOption: the renderer's wrapper and the answers function", () => {
  it.each(groupsOf("matchOption"))("%s", (_title, group) => {
    const { memo } = scenarioOf(group.scenario);
    const model = modelOf(memo, group.target as Target, group.override);
    const free = group.acceptsFreeText as boolean;
    for (const run of group.runs) {
      const where = `${label(group)} raw ${JSON.stringify(run.raw)}`;
      expectSameJson(matchOption(model, fromJson(run.raw), group.path as string, free), run.result, where);
      expectAnswerMatches(answersMatchOption(model, fromJson(run.raw), group.path as string, { acceptsFreeText: free, locale: memo.locale }), run.result, where);
    }
  });
});

describe("coerceRows (renderer wording) and coerceRowsAnswer (hint-free)", () => {
  it.each(groupsOf("coerceRows"))("%s", (_title, group) => {
    const { memo } = scenarioOf(group.scenario);
    const columns = fromJson(group.columns) as FieldColumn[];
    const free = group.freeColumns ?? [];
    const cellModel = (column: FieldColumn): RenderComponentModel | undefined => (column.key === group.missingCell ? undefined : memo.modelById.get(column.id));
    const options = { locale: group.locale as string, acceptsFreeText: (column: FieldColumn) => free.includes(column.key) };
    for (const run of group.runs) {
      const where = `${label(group)} raw ${JSON.stringify(run.raw).slice(0, 80)}`;
      expectSameJson(coerceRows(fromJson(run.raw), group.path as string, columns, cellModel, options), run.result, where);
      const shared = coerceRowsAnswer(fromJson(run.raw), group.path as string, columns, cellModel, options);
      const expected = run.result as { rows?: Json; refusal?: GoldenRefusal };
      if (expected.refusal !== undefined) {
        expect(shared.ok, where).toBe(false);
        if (!shared.ok) {
          expectProblemMatches(shared.problem, expected.refusal, where);
        }
      } else {
        expect(toJson(shared), where).toEqual({ ok: true, rows: expected.rows });
      }
    }
  });
});

describe("writeGuard (renderer wording) and writabilityOfState (hint-free)", () => {
  it.each(groupsOf("writeGuard"))("%s", (_title, group) => {
    const { memo, runtime } = scenarioOf(group.scenario);
    const context = group.context as { focused: string | null; dataSourcesAllowed: boolean };
    for (const run of group.runs) {
      const where = `${label(group)} ref ${String(run.ref)}`;
      const resolved = resolveRef(run.ref as string, memo, runtime);
      if (run.resolved === null) {
        expect(resolved, where).toBeUndefined();
        continue;
      }
      expect(resolved, where).toBeDefined();
      if (resolved === undefined) {
        continue;
      }
      expect(toJson({ path: resolved.path, id: resolved.id, row: resolved.row }), where).toEqual(run.resolved);
      const guard = writeGuard(resolved, memo, runtime, { focused: context.focused ?? undefined, dataSourcesAllowed: context.dataSourcesAllowed });
      expectSameJson(guard, run.result, where);
      // The effective-state half alone, read as writeGuard reads it (here the memo and the
      // runtime agree; the lagging memo is the next block's).
      const stateId = resolved.row !== undefined ? resolved.row.ownerId : resolved.model.id;
      const effective = runtime.effectiveState(stateId) ?? runtime.effectiveState(resolved.model.id);
      const cell = resolved.row !== undefined ? runtime.effectiveState(resolved.model.id) : undefined;
      const writability = writabilityOfState(resolved.model, kindOfNode(resolved.model), effective, cell);
      const refusal = run.result as GoldenRefusal | { $undefined: true };
      if ("code" in refusal && refusal.code === "not-writable") {
        const details = refusal.details as { reason: string; unfillableKind?: string };
        expect(toJson(writability), where).toEqual({ writable: false, why: details.reason, ...(details.unfillableKind !== undefined ? { unfillableKind: details.unfillableKind } : {}) });
      } else {
        expect(writability, where).toEqual({ writable: true });
      }
    }
  });
});

describe("writabilityOfState reads the fresh state the memo lags (writeGuard's effective-state half)", () => {
  const context = { focused: undefined, dataSourcesAllowed: true };

  /**
   * A memo built at one revision, then the runtime moved on by `change` through `setValue`: the
   * memo's model still says writable, the runtime's effective state no longer does.
   */
  async function lagging(scenario: Scenario, ref: string, change: Record<string, unknown>, definition?: FormDefinition) {
    const { runtime, memo } = await build(scenario, definition);
    const resolved = resolveRef(ref, memo, runtime);
    if (resolved === undefined) {
      throw new Error(`no ref ${ref}`);
    }
    const kind = kindOfNode(resolved.model);
    expect(writabilityOf(resolved.model, kind), `${ref}: the memo, built before the change`).toEqual({ writable: true });
    for (const [path, value] of Object.entries(change)) {
      runtime.setValue(path, value);
      runtime.commitValue(path);
    }
    // Read as writeGuard reads it: the owner's state for a row cell, and the cell's own.
    const state = runtime.effectiveState(resolved.row?.ownerId ?? resolved.model.id);
    const cell = resolved.row !== undefined ? runtime.effectiveState(resolved.model.id) : undefined;
    return { runtime, memo, resolved, kind, state, cell };
  }

  it.each<[string, Scenario, string, Record<string, unknown>, "hidden" | "disabled" | "readonly"]>([
    ["a visibleWhen hides the field", { definition: "single", dataSources: "default", values: { has_other: true } }, "other", { has_other: false }, "hidden"],
    ["an enabledWhen disables it", { definition: "journey", dataSources: "default", values: { wants_details: true } }, "nickname", { wants_details: false }, "disabled"],
    ["a readonlyWhen makes it read-only", { definition: "journey", dataSources: "default", values: { wants_details: true } }, "nickname", { applicant_name: "Locked" }, "readonly"]
  ])("%s after the memo was built", async (_title, scenario, ref, change, why) => {
    const { runtime, memo, resolved, kind, state } = await lagging(scenario, ref, change);
    expect(writabilityOfState(resolved.model, kind, state)).toEqual({ writable: false, why });
    expectSameJson(writeGuard(resolved, memo, runtime, context), toJson(notWritable(ref, why)), ref);
  });

  it("a row cell hidden by its own rule: only the cell's state carries it, the table's stays visible", async () => {
    const definition = fromJson(golden.definitions.single) as FormDefinition;
    const grid = definition.root.children?.content?.find((node) => node.id === "grid");
    const when = grid?.children?.content?.find((node) => node.id === "when");
    if (when === undefined) {
      throw new Error("no grid cell 'when' in the single definition");
    }
    when.rules = { visibleWhen: "has_other = false" };
    const { runtime, memo, resolved, kind, state, cell } = await lagging({ definition: "single", dataSources: "default", values: { has_other: false } }, "grid[0].when", { has_other: true }, definition);
    expect(resolved.row?.ownerId).toBe("grid");
    expect(state?.visible).toBe(true);
    expect(cell?.visible).toBe(false);
    expect(writabilityOfState(resolved.model, kind, state, undefined), "the table's state alone").toEqual({ writable: true });
    expect(writabilityOfState(resolved.model, kind, state, cell)).toEqual({ writable: false, why: "hidden" });
    expectSameJson(writeGuard(resolved, memo, runtime, context), toJson(notWritable("grid[0].when", "hidden")), "grid[0].when");
  });
});

describe("writabilityOfState: each flag on its own, from the field's state or the cell's", () => {
  const clear: WritableState = { visible: true, disabled: false, readonly: false };
  const hidden: Writability = { writable: false, why: "hidden" };
  const disabled: Writability = { writable: false, why: "disabled" };
  const readonly: Writability = { writable: false, why: "readonly" };
  const calculated: Writability = { writable: false, why: "calculated" };

  // [title, scenario, model id, model override, state, cell, expected]; `when` is the single
  // form's grid cell (its model is the row template's), `double` its calculated field.
  it.each<[string, string, string, Partial<RenderComponentModel> | undefined, WritableState | undefined, WritableState | undefined, Writability]>([
    ["a writable field, no state", "single", "name", undefined, undefined, undefined, { writable: true }],
    ["a writable field, every flag clear", "single", "name", undefined, clear, clear, { writable: true }],
    ["state hidden", "single", "name", undefined, { visible: false }, undefined, hidden],
    ["state disabled", "single", "name", undefined, { disabled: true }, undefined, disabled],
    ["state read-only", "single", "name", undefined, { readonly: true }, undefined, readonly],
    ["cell hidden, the table's state clear", "single", "when", undefined, clear, { visible: false }, hidden],
    ["cell hidden, no state", "single", "when", undefined, undefined, { visible: false }, hidden],
    ["cell disabled, no state", "single", "when", undefined, undefined, { disabled: true }, disabled],
    ["cell read-only, no state", "single", "when", undefined, undefined, { readonly: true }, readonly],
    ["hidden before disabled before read-only", "single", "name", undefined, { visible: false, disabled: true, readonly: true }, undefined, hidden],
    ["disabled before read-only, across state and cell", "single", "when", undefined, { readonly: true }, { disabled: true }, disabled],
    ["a calculated field answers calculated, read-only state or not", "single", "double", undefined, { readonly: true }, undefined, calculated],
    ["a calculation is static: no state lifts it, whatever the memo's readOnly", "single", "double", { readOnly: false }, undefined, undefined, calculated],
    ["a table's state read-only leaves it writable (its cells are judged per cell)", "single", "grid", undefined, { readonly: true }, undefined, { writable: true }],
    ["a table read-only by its own model", "single", "grid", { readOnly: true }, clear, undefined, readonly],
    ["a table hidden", "single", "grid", undefined, { visible: false }, undefined, hidden],
    ["a table disabled", "single", "grid", undefined, { disabled: true }, undefined, disabled],
    ["a button keeps its static reason", "single", "send", undefined, { visible: false, disabled: true }, { visible: false }, { writable: false, why: "unfillable", unfillableKind: "button" }],
    ["a static drawing keeps its static reason", "single", "blurb", undefined, { visible: false }, undefined, { writable: false, why: "unfillable", unfillableKind: "static" }],
    ["a file field keeps its static reason", "single", "receipt", undefined, { visible: false }, undefined, { writable: false, why: "unfillable", unfillableKind: "file" }],
    ["a group keeps its static reason", "single", "dates", undefined, { visible: false }, undefined, { writable: false, why: "group" }],
    ["a presentation's own field keeps its static reason", "presentation", "m1", undefined, { visible: false }, undefined, { writable: false, why: "presentation" }]
  ])("%s", (title, scenario, id, override, state, cell, expected) => {
    const found = modelOf(scenarioOf(scenario).memo, { id });
    const model = (override === undefined ? found : { ...found, ...override }) as RenderComponentModel;
    expect(model.visible && !model.disabled, `${title}: the memo's model is visible and enabled`).toBe(true);
    expect(writabilityOfState(model, kindOfNode(model), state, cell), title).toEqual(expected);
  });
});

// ---- the import walk --------------------------------------------------------------------------------

/**
 * Every module specifier a file names: `from "…"` (imports and re-exports, type-only ones too),
 * a side-effect `import "…"`, and a dynamic `import("…")`.
 */
function specifiersOf(text: string): string[] {
  return [...text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** The source file a relative specifier names (`./x.js` is `./x.ts`); undefined for a package. */
function sourceOf(from: string, specifier: string, exists: (path: string) => boolean): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(from), specifier);
  const found = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, resolve(base, "index.ts")].find(exists);
  if (found === undefined) {
    throw new Error(`${from}: cannot resolve ${specifier}`);
  }
  return found;
}

/**
 * Every file the entries reach through relative imports, each with the chain that reached it
 * (the file first). Type-only edges are followed too: the module is meant to stand apart from
 * the renderer's and the builder's tool modules entirely, not only in what a bundle carries.
 */
function closureOf(entries: string[], read: (path: string) => string, exists: (path: string) => boolean): Map<string, string[]> {
  const reached = new Map<string, string[]>(entries.map((entry) => [entry, [entry]]));
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const specifier of specifiersOf(read(file))) {
      const target = sourceOf(file, specifier, exists);
      if (target !== undefined && !reached.has(target)) {
        reached.set(target, [target, ...(reached.get(file) as string[])]);
        queue.push(target);
      }
    }
  }
  return reached;
}

describe("agent/answers stays hint-free and catalogue-free", () => {
  const agent = resolve(__dirname, "../form-engine/agent");
  const dir = resolve(agent, "answers");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  const forbidden = (path: string) => path.startsWith(`${agent}/form/`) || path.startsWith(`${agent}/builder/`);

  it("holds the module files", () => {
    expect(files.sort()).toEqual(expect.arrayContaining(["coerce.ts", "index.ts", "kinds.ts", "match.ts", "writability.ts"]));
  });

  it("reads every form of import, and the walk follows a re-export through the agent barrel", () => {
    const sample = [
      'import "../form/tools.js";',
      'export { agentText as _x } from "../index.js";',
      'import type { X } from "./x.js";',
      "const lazy = await import('../builder/y.js');",
      'import {\n  z\n} from "./z.js";',
      'export * from "./w.js";'
    ].join("\n");
    expect(specifiersOf(sample)).toEqual(["../form/tools.js", "../index.js", "./x.js", "../builder/y.js", "./z.js", "./w.js"]);
    const fake = new Map([
      [`${dir}/match.ts`, 'export { agentText as _x } from "../index.js";\nimport { cutString } from "pkg";'],
      [`${agent}/index.ts`, 'export * from "./form/tools.js";'],
      [`${agent}/form/tools.ts`, 'import "./host.js";'],
      [`${agent}/form/host.ts`, ""]
    ]);
    const reached = closureOf([`${dir}/match.ts`], (path) => fake.get(path) ?? "", (path) => fake.has(path));
    expect([...reached.keys()].filter(forbidden)).toEqual([`${agent}/form/tools.ts`, `${agent}/form/host.ts`]);
  });

  it.each(files)("%s imports nothing from agent/form/ or agent/builder/ and spells no tool name the builder bundle must not carry", (name) => {
    const text = readFileSync(resolve(dir, name), "utf8");
    const specifiers = specifiersOf(text);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith("."), `${name}: ${specifier} (the engine imports by relative path)`).toBe(true);
      const target = resolve(dir, specifier);
      for (const root of [resolve(agent, "form"), resolve(agent, "builder")]) {
        expect(target === root || target.startsWith(`${root}/`), `${name}: ${specifier}`).toBe(false);
      }
    }
    for (const word of ["set_answers", "describe_form", "describe_builder"]) {
      expect(text.includes(word), `${name} spells ${word}`).toBe(false);
    }
  });

  it("reaches no file under agent/form/ or agent/builder/ through any chain of imports", () => {
    const reached = closureOf(
      files.map((name) => resolve(dir, name)),
      (path) => readFileSync(path, "utf8"),
      existsSync
    );
    // The walk left the module (it reaches the render model and the core it reads).
    expect([...reached.keys()].some((path) => !path.startsWith(`${dir}/`))).toBe(true);
    const offending = [...reached].filter(([path]) => forbidden(path)).map(([, chain]) => chain.join(" <- "));
    expect(offending).toEqual([]);
  });
});
