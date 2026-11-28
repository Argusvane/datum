/**
 * The tried form as the `try_it` body reads it:
 * an index of what Try it draws now, built from the tried runtime with the renderer's own model
 * builder (`buildRuntimeRenderOutput`, render/core), the resolution of a value path to the model
 * it names, the per-path refusals in Try it's own words, the rows of a table, and the tried
 * fields as `try_it { action: 'read' }` lists them.
 *
 * Reading and writability come from the shared answers module (`agent/answers/`), so a
 * tried field takes exactly the answers the form takes; the words are this module's. Guard 15:
 * the builder bundle never spells the renderer catalogue's tool names, so no hint here names a
 * renderer tool; the hints name `try_it`'s own actions and the builder's reads.
 *
 * Imported only by `agentpart-try.ts` (helpers of a body are named after it and land in
 * its chunk); the only module of `agent/builder/` besides the body that value-imports
 * `render/core/**` and `agent/answers/**`. Nothing runs at import time.
 */
import type { FormError } from "../../core/errors/form-error.js";
import type { PresentationIndex } from "../../core/journey/presentation.js";
import { addressOf, resolveText } from "../../core/localization/translations.js";
import { ENGINE_VALIDATION_CODES, layerValidationMessages, readValidationMessages, resolveValidationMessage, type ValidationMessageCatalog } from "../../core/localization/validation-messages.js";
import { DATA_GRID_ROWS_CAP, dataGridSettingsOf, isDataGrid, rowOperationsOf } from "../../core/schema/data-grid.js";
import { ANSWERS_FREE_PROPERTY_PATH } from "../../core/schema/data-source-capability.js";
import { journeyPageFormIds, type JourneyPage } from "../../core/schema/journey.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { buildRowKeys, collectionPathOf, isGroupNode } from "../../core/tree/data-scope.js";
import { collectionEntryCount, type RenderComponentModel } from "../../render/core/component-model.js";
import type { RenderOutput } from "../../render/core/render-orchestrator.js";
import { buildRuntimeRenderOutput } from "../../render/core/runtime-render-bridge.js";
import type { TryCheckProblem } from "../../builder/web-component/try-it-types.js";
import type { FieldKind } from "../../registry/kinds.js";
import {
  STRING_VALUE_CAP,
  isNestedCollection,
  kindOfNode,
  unfillableStaticKind,
  writabilityOfState,
  type AnswerProblem,
  type FieldColumn,
  type UnfillableKind,
  type WhyNotWritable,
  type Writability,
  type WritabilityPlace
} from "../answers/index.js";
import { cutString } from "../result-caps.js";
import { ToolRefusal } from "../tool-types.js";
import type { TriedRuntime } from "./host.js";
import type { ItemRefusal, TriedField, TryProblem } from "./types.js";

/** The runtime's own path grammar (the form's value paths), at most 256 characters. */
export const TRY_PATH_PATTERN = /^@?[A-Za-z0-9_-]+(\[\d+\])?(\.[A-Za-z0-9_-]+(\[\d+\])?)*$/u;
export const TRY_PATH_MAX = 256;

/** How long the index waits for data sources before drawing the slow ones as loading (the readers' 5 s). */
export const TRY_INDEX_BUDGET_MS = 5_000;

const LABEL_CAP = 200;
const VALUE_CAP = 2_000;
const SUGGESTIONS_CAP = 5;
const SUGGESTION_DISTANCE = 3;
/** How many options a `no-such-option` refusal lists (the answers module's own cut). */
const PROBLEMS_CAP = 100;

/** What Try it draws now, indexed by component id and by value path (row cells included). */
export interface TriedIndex {
  runtime: TriedRuntime;
  locale: string;
  output: RenderOutput;
  models: readonly RenderComponentModel[];
  /** The first model of each id that is not a row's copy (a row cell shares its template's id). */
  modelById: Map<string, RenderComponentModel>;
  /** Every value path drawn, row cells included; the first model wins a shared path. */
  modelByPath: Map<string, RenderComponentModel>;
  /** Row template field id → its key within an entry (`qty`). */
  rowKeys: Map<string, string>;
  /** Built after the data sources' budget ran out: a slow source is drawn as loading. */
  provisional: boolean;
  /**
   * On a journey, the components of the page Try it shows (its members and everything inside
   * them); `undefined` when the whole form is on show. The models hold every page's components,
   * as the renderer's do, and a journey draws the current page's alone.
   */
  onPage: ReadonlySet<string> | undefined;
}

/** A budget that can be disarmed once the race it guards is won. */
function budget(ms: number): { expired: Promise<"timer">; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timer">((resolve) => {
    timer = setTimeout(() => resolve("timer"), ms);
  });
  return {
    expired,
    clear() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  };
}

/**
 * The tried form's models, drawn the way the canvas's renderer draws them ("interactive": a
 * journey's current page only). A data source slower than `budgetMs` is drawn as loading from
 * what had answered (the renderer catalogue's provisional build), so a read never waits on it.
 */
export async function indexTried(runtime: TriedRuntime, budgetMs: number = TRY_INDEX_BUDGET_MS): Promise<TriedIndex> {
  const answerMemo = new Map<string, never>();
  const full = buildRuntimeRenderOutput(runtime, "interactive", { answerMemo });
  const timer = budget(budgetMs);
  let settled: { output: RenderOutput } | "timer";
  try {
    settled = await Promise.race([full.then((output) => ({ output })), timer.expired]);
  } finally {
    timer.clear();
  }
  let output: RenderOutput;
  let provisional = false;
  if (settled === "timer") {
    void full.catch(() => undefined);
    output = await buildRuntimeRenderOutput(runtime, "interactive", { answerMemo, provisional: true });
    provisional = true;
  } else {
    output = settled.output;
  }
  const models = output.components as readonly RenderComponentModel[];
  const modelById = new Map<string, RenderComponentModel>();
  const modelByPath = new Map<string, RenderComponentModel>();
  for (const model of models) {
    if (!modelById.has(model.id) || model.row === undefined) {
      modelById.set(model.id, model);
    }
    if (!modelByPath.has(model.valuePath)) {
      modelByPath.set(model.valuePath, model);
    }
    for (const entry of model.rows?.entries ?? []) {
      for (const cell of entry) {
        if (!modelByPath.has(cell.valuePath)) {
          modelByPath.set(cell.valuePath, cell);
        }
      }
    }
  }
  return { runtime, locale: runtime.state().locale, output, models, modelById, modelByPath, rowKeys: buildRowKeys(runtime.formRoot()), provisional, onPage: pageOf(runtime, models, modelById) };
}

/** The components a journey's current page draws: its members and their descendants. */
function pageOf(runtime: TriedRuntime, models: readonly RenderComponentModel[], modelById: ReadonlyMap<string, RenderComponentModel>): Set<string> | undefined {
  const view = runtime.journeyView?.();
  if (view === undefined) {
    return undefined;
  }
  const members = new Set(view.members);
  const on = new Set<string>();
  for (const model of models) {
    let current: RenderComponentModel | undefined = model;
    while (current !== undefined) {
      if (members.has(current.id)) {
        on.add(model.id);
        break;
      }
      current = current.parentId !== undefined ? modelById.get(current.parentId) : undefined;
    }
  }
  return on;
}

/** Whether Try it shows the model now: visible, and on the journey's current page when one runs. */
export function shownNow(index: TriedIndex, model: RenderComponentModel, visible: boolean = model.visible): boolean {
  return visible && (index.onPage === undefined || index.onPage.has(model.id));
}

// ---- the registrar's input refusals, for what the schema subset cannot say -----------------------

/** `bad-input` with every problem at once (the registrar's shape and hint). */
export function badInput(problems: ReadonlyArray<{ key: string; expected: string }>, message = "The arguments do not fit try_it's schema."): ToolRefusal {
  return new ToolRefusal("bad-input", message, "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.", {
    problems: problems.map((problem) => ({ ...problem }))
  });
}

/** `too-large { what: "input" }` for a list over its cap. */
export function tooLarge(key: string, limit: number, got: number): ToolRefusal {
  return new ToolRefusal("too-large", `${key} carries ${got} entries, over the ${limit} entry limit.`, `Send fewer items per call (at most ${limit} for ${key}) and call again for the rest.`, {
    what: "input",
    limit,
    got,
    key
  });
}

// ---- values ---------------------------------------------------------------------------------

/** JSON with object keys sorted: two reads of the same answer compare equal (`memory.tried`). */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (typeof input !== "object" || input === null) {
      return input;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      const inner = (input as Record<string, unknown>)[key];
      if (inner !== undefined) {
        out[key] = sort(inner);
      }
    }
    return out;
  };
  try {
    return JSON.stringify(sort(value) ?? null);
  } catch {
    return "";
  }
}

/** An answer the person or the agent gave: not empty, not a record of unticked choices. */
export function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((inner) => inner === true || (inner !== false && nonEmpty(inner)));
  }
  return true;
}

/** The tried answers: what the tried runtime holds and which keys were typed. */
export interface TypedAnswers {
  values: Record<string, unknown>;
  dirty: ReadonlySet<string>;
}

/**
 * Who gave each typed answer: a key the agent wrote and that still
 * holds its value is the assistant's; any other non-empty key the person typed (a dirty key, or a
 * cell of a table whose rows they changed) is the person's. Calculations and defaults are nobody's.
 */
export function typedCounts(typed: TypedAnswers, tried: ReadonlyMap<string, string>): { byPerson: number; byAssistant: number; personKeys: string[] } {
  let byAssistant = 0;
  const personKeys: string[] = [];
  for (const [key, value] of Object.entries(typed.values)) {
    if (!nonEmpty(value)) {
      continue;
    }
    if (tried.get(key) === canonicalJson(value)) {
      byAssistant += 1;
      continue;
    }
    if (typedByPerson(key, typed.dirty)) {
      personKeys.push(key);
    }
  }
  return { byPerson: personKeys.length, byAssistant, personKeys };
}

/** A key the person typed: dirty itself, or a cell of a table whose rows they added or removed. */
function typedByPerson(key: string, dirty: ReadonlySet<string>): boolean {
  if (dirty.has(key)) {
    return true;
  }
  const bracket = key.indexOf("[");
  return bracket > 0 && dirty.has(key.slice(0, bracket));
}

/** Whose answer a key holds now, for a tried field's `typedBy`. */
export function typedByOf(key: string, value: unknown, typed: TypedAnswers, tried: ReadonlyMap<string, string>): "person" | "assistant" | undefined {
  if (!nonEmpty(value)) {
    return undefined;
  }
  if (tried.get(key) === canonicalJson(value)) {
    return "assistant";
  }
  return typedByPerson(key, typed.dirty) ? "person" : undefined;
}

// ---- rows -----------------------------------------------------------------------------------

/** Where a table's entries live. */
export function collectionOf(model: RenderComponentModel): string {
  return model.rows?.collectionPath ?? collectionPathOf(model.node) ?? model.valuePath;
}

/** A table's rows as the tried answers hold them: one object per entry, a key per field written. */
export function rowsOf(values: Readonly<Record<string, unknown>>, collection: string): Record<string, unknown>[] {
  const count = collectionEntryCount(values, collection);
  const rows: Record<string, unknown>[] = Array.from({ length: count }, () => ({}));
  const prefix = `${collection}[`;
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const close = key.indexOf("]", prefix.length);
    if (close <= prefix.length || key.charAt(close + 1) !== ".") {
      continue;
    }
    const index = Number(key.slice(prefix.length, close));
    const field = key.slice(close + 2);
    if (Number.isInteger(index) && index < count && field !== "") {
      (rows[index] as Record<string, unknown>)[field] = value;
    }
  }
  return rows;
}

/** A table's row-count bounds: the runtime's (rules laid over), else its settings; the grid cap at most. */
export function rowBoundsOf(model: RenderComponentModel, runtime: TriedRuntime): { min: number; max: number | null } {
  const live = runtime.dataGridRowBounds?.()[model.id];
  if (live !== undefined) {
    return { min: live.minRows, max: live.maxRows ?? null };
  }
  if (isDataGrid(model.node)) {
    const settings = dataGridSettingsOf(model.node);
    return { min: settings.minRows, max: settings.maxRows ?? null };
  }
  return { min: 0, max: null };
}

/** The most rows a table may hold now. */
export function rowCapOf(bounds: { max: number | null }): number {
  return bounds.max ?? DATA_GRID_ROWS_CAP;
}

export { rowOperationsOf };

/** A table's columns from its row template, each with its kind (the renderer's reading). */
export function columnsOf(model: RenderComponentModel, index: TriedIndex): FieldColumn[] {
  const columns: FieldColumn[] = [];
  const walk = (node: ComponentNode): void => {
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children ?? []) {
        const key = index.rowKeys.get(child.id);
        const template = index.modelById.get(child.id);
        if (key !== undefined && template !== undefined && !(isGroupNode(child) && child.collection === undefined) && unfillableStaticKind(template) === undefined) {
          columns.push({ key, id: child.id, label: cutString(template.label, LABEL_CAP), kind: kindOfNode(template), required: template.accessibility.required });
        }
        if (child.collection === undefined) {
          walk(child);
        }
      }
    }
  };
  walk(model.node);
  return columns;
}

/** A choice whose `data.answersFree` is true takes an answer outside its options. */
export function acceptsFreeText(node: ComponentNode): boolean {
  let cursor: unknown = node.configuration;
  for (const part of ANSWERS_FREE_PROPERTY_PATH.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor === true;
}

// ---- resolving a path ------------------------------------------------------------------------

/** A row-entry path taken apart: `items[2].qty`. */
export interface RowRef {
  collection: string;
  index: number;
  key: string;
  ownerId: string;
  /** The row is there now. */
  exists: boolean;
}

/** What a path names: the model to read and write it by, the path the write goes to. */
export interface ResolvedPath {
  model: RenderComponentModel;
  path: string;
  id: string;
  row?: RowRef;
}

function rowPathOf(path: string): { collection: string; index: number; key: string } | undefined {
  const match = /^(.*?)\[(\d+)\]\.(.+)$/u.exec(path);
  if (match === null) {
    return undefined;
  }
  const [, collection, index, key] = match;
  if (collection === undefined || index === undefined || key === undefined || collection.includes("[")) {
    return undefined;
  }
  return { collection, index: Number(index), key };
}

/** The table that owns a row template field, when it is one. */
function ownerOfTemplate(model: RenderComponentModel, index: TriedIndex): RenderComponentModel | undefined {
  if (!index.rowKeys.has(model.id) || model.row !== undefined) {
    return undefined;
  }
  let current = model.parentId !== undefined ? index.modelById.get(model.parentId) : undefined;
  while (current !== undefined) {
    if (current.rows !== undefined) {
      return current;
    }
    current = current.parentId !== undefined ? index.modelById.get(current.parentId) : undefined;
  }
  return undefined;
}

function rowRef(index: TriedIndex, template: RenderComponentModel, collection: string, row: number, key: string, ownerId: string): ResolvedPath {
  const path = `${collection}[${row}].${key}`;
  const count = collectionEntryCount(index.runtime.state().values, collection);
  const cell = index.modelByPath.get(path);
  return { model: cell ?? template, path, id: template.id, row: { collection, index: row, key, ownerId, exists: row < count } };
}

/**
 * Resolves a path the way the form reads it: the exact value path drawn (row cells included),
 * then a component id, then a row-entry path through the table's row template; a template field
 * named bare is its first row's cell. `undefined` when nothing matches.
 */
export function resolveTried(ref: string, index: TriedIndex): ResolvedPath | undefined {
  const byPath = index.modelByPath.get(ref) ?? index.modelById.get(ref);
  if (byPath !== undefined && byPath.parentId !== undefined) {
    if (byPath.row !== undefined) {
      const parsed = rowPathOf(byPath.valuePath);
      const key = byPath.rowKey ?? parsed?.key ?? byPath.id;
      return { model: byPath, path: byPath.valuePath, id: byPath.id, row: { collection: byPath.row.collectionPath, index: byPath.row.index, key, ownerId: byPath.row.ownerId, exists: true } };
    }
    const owner = ownerOfTemplate(byPath, index);
    if (owner !== undefined && !isNestedCollection(byPath)) {
      return rowRef(index, byPath, collectionOf(owner), 0, index.rowKeys.get(byPath.id) as string, owner.id);
    }
    return { model: byPath, path: byPath.valuePath, id: byPath.id };
  }
  const parsed = rowPathOf(ref);
  if (parsed !== undefined) {
    const owner = index.models.find((model) => model.rows !== undefined && collectionOf(model) === parsed.collection);
    if (owner !== undefined) {
      for (const [id, key] of index.rowKeys) {
        const template = index.modelById.get(id);
        if (key === parsed.key && template !== undefined && ownerOfTemplate(template, index) === owner) {
          return rowRef(index, template, parsed.collection, parsed.index, parsed.key, owner.id);
        }
      }
    }
  }
  return undefined;
}

/**
 * Where an `@` model stands, for the shared writability module (as the renderer's
 * `guards.ts` reads it): a journey presentation's own value field
 * is written like a form field on the page the person sees now, so the place says whether the
 * model is one (its id keyed in the presentation index's `ownKeys` to this very path) and drawn
 * on the journey's current page (the index's `pageOf`). The tried runtime's type shows only a
 * part of that index; a journey's preview runs a whole `FormRuntime`, whose index carries both
 * records, read here when they are there. Any other `@` node (the presentation's container, an
 * own layout, a placeholder), an own field of another page, and one the index cannot place stay
 * `presentation`, with the hint that names navigate.
 */
function placeOf(model: RenderComponentModel, runtime: TriedRuntime): WritabilityPlace | undefined {
  if (!model.valuePath.startsWith("@")) {
    return undefined;
  }
  const index = runtime.presentationIndex?.() as Partial<Pick<PresentationIndex, "ownKeys" | "pageOf">> | undefined;
  const own = index?.ownKeys?.[model.id] === model.valuePath;
  const page = index?.pageOf?.[model.id];
  return { ownFieldOnPage: own && page !== undefined && page === runtime.journeyView?.()?.pageId };
}

/** Writability now: the static reasons (an own field placed on its page), then the effective state read fresh from the tried runtime. */
export function writabilityOfPath(resolved: ResolvedPath, index: TriedIndex): Writability {
  const states = index.runtime.effectiveStatesMap();
  const stateId = resolved.row !== undefined ? resolved.row.ownerId : resolved.model.id;
  const effective = states.get(stateId) ?? states.get(resolved.model.id);
  const cell = resolved.row !== undefined ? states.get(resolved.model.id) : undefined;
  return writabilityOfState(resolved.model, kindOfNode(resolved.model), effective, cell, placeOf(resolved.model, index.runtime));
}

// ---- Try it's words for a refused path ---------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** Up to five paths or ids within an edit distance of three of `ref`, nearest first. */
export function suggestionsFor(ref: string, index: TriedIndex): string[] {
  const candidates = new Set<string>();
  for (const model of index.models) {
    if (model.parentId === undefined || model.row !== undefined || unfillableStaticKind(model) !== undefined) {
      continue;
    }
    candidates.add(model.valuePath);
    candidates.add(model.id);
  }
  const lower = ref.toLowerCase();
  return [...candidates]
    .map((candidate) => ({ candidate, distance: levenshtein(lower, candidate.toLowerCase()) }))
    .filter(({ distance }) => distance <= SUGGESTION_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, SUGGESTIONS_CAP)
    .map(({ candidate }) => candidate);
}

export function unknownFieldRefusal(ref: string, index: TriedIndex): ItemRefusal {
  const suggestions = suggestionsFor(ref, index);
  return {
    code: "unknown-field",
    message: `No tried field has the path '${ref}'.`,
    hint: `Use a path from get_form or try_it { action: 'read' }; did you mean ${suggestions.length > 0 ? suggestions.join(", ") : "one of the listed paths"}?`,
    details: { ref, suggestions }
  };
}

const NOT_WRITABLE_HINTS: Readonly<Record<WhyNotWritable, string>> = {
  hidden: "The form hides this field right now; another answer may reveal it (try_it { action: 'read', include: 'all' } lists the hidden ones).",
  disabled: "The form does not allow changing this field; tell the person.",
  readonly: "The form does not allow changing this field; tell the person.",
  calculated: "The form works this value out itself; write the fields it depends on.",
  unfillable: "Files, signatures, buttons and nested tables must be handled by the person; ask them.",
  group: "This is a container; write its fields' paths instead.",
  presentation: "This field belongs to another page of the journey; move there with try_it { action: 'navigate' }, then fill it."
};

export function notWritableRefusal(path: string, why: WhyNotWritable, unfillableKind?: UnfillableKind): ItemRefusal {
  const details: Record<string, unknown> = { path, reason: why };
  if (unfillableKind !== undefined) {
    details.unfillableKind = unfillableKind;
  }
  const what =
    why === "hidden"
      ? "is hidden right now"
      : why === "disabled"
        ? "is disabled"
        : why === "readonly"
          ? "is read-only"
          : why === "calculated"
            ? "is worked out by the form"
            : why === "group"
              ? "is a container"
              : why === "presentation"
                ? "belongs to another page of the journey"
                : `cannot be filled by an assistant (${unfillableKind ?? "unfillable"})`;
  return { code: "not-writable", message: `The tried field '${path}' ${what}.`, hint: NOT_WRITABLE_HINTS[why], details };
}

function describeGot(got: unknown): string {
  if (typeof got === "string") {
    return `'${got.length > 60 ? `${got.slice(0, 57)}…` : got}'`;
  }
  if (got === null) {
    return "null";
  }
  if (typeof got === "object") {
    return Array.isArray(got) ? "An array" : "An object";
  }
  return String(got);
}

/** The answers module's problem in Try it's words: the renderer's codes and details. */
export function answerRefusal(problem: AnswerProblem): ItemRefusal {
  const details = problem.details ?? { path: problem.path };
  switch (problem.code) {
    case "invalid-value": {
      const expected = problem.expected ?? "a value the field takes";
      const message = problem.kind === "date" ? `${describeGot(problem.input)} is not a date in the form YYYY-MM-DD.` : `${describeGot(problem.input)} is not ${expected} for '${problem.path}'.`;
      return { code: "invalid-value", message, hint: `Pass ${expected} for \`${problem.path}\`.`, details };
    }
    case "too-large":
      return {
        code: "too-large",
        message: `The value for '${problem.path}' is ${String(details.got)} characters long, over the ${STRING_VALUE_CAP} character limit.`,
        hint: `Send a shorter value (at most ${STRING_VALUE_CAP} characters for ${problem.path}).`,
        details
      };
    case "options-loading":
      return {
        code: "options-loading",
        message: `The choices of '${problem.path}' have not loaded yet in Try it, so the value cannot be checked.`,
        hint: "The field's choices are still loading; call try_it { action: 'fill' } for it again in a moment.",
        details
      };
    case "options-failed":
      return {
        code: "options-failed",
        message: `The choices of '${problem.path}' failed to load in Try it, so the value cannot be checked.`,
        hint: "The field's choices did not load; tell the person and leave the field.",
        details
      };
    case "option-ambiguous":
      return {
        code: "option-ambiguous",
        message: `${(details.candidates as unknown[] | undefined)?.length ?? 2} options of '${problem.path}' share the label '${String(details.got)}'.`,
        hint: "Send the option's `value` instead of its label.",
        details
      };
    case "no-such-option":
      return {
        code: "no-such-option",
        message: `'${String(details.got)}' matches no option value or label of '${problem.path}'.`,
        hint: `Pick one of the listed option values; get_component lists all ${String(details.total)} of this field's own options.`,
        details
      };
  }
}

export function fieldInUseRefusal(path: string, label: string): ItemRefusal {
  return {
    code: "field-in-use",
    message: `The person is typing in ${label === "" ? `'${path}'` : label}.`,
    hint: "The person is typing there; fill the other fields now and retry this one.",
    details: { path }
  };
}

export function noSuchRowRefusal(collection: string, index: number, rows: number): ItemRefusal {
  return {
    code: "no-such-row",
    message: `'${collection}' has ${rows} rows in Try it; there is no row ${index}.`,
    hint: `The table has ${rows} rows; add one with try_it { action: 'edit_rows' }, or pass the whole table as an array to try_it { action: 'fill' }.`,
    details: { collection, index, rows }
  };
}

export function rowsLockedRefusal(collection: string, operation: "add" | "remove" | "replace"): ItemRefusal {
  const done = operation === "add" ? "added" : operation === "remove" ? "removed" : "replaced";
  return { code: "rows-locked", message: `Rows of '${collection}' cannot be ${done}.`, hint: `Rows cannot be ${done} here; tell the person.`, details: { collection, operation } };
}

export function rowsLimitRefusal(collection: string, bounds: { min: number; max: number | null }, rows: number, asked: number): ItemRefusal {
  return {
    code: "rows-limit",
    message: `'${collection}' would hold ${asked} rows, outside its bounds.`,
    hint: `The table allows between ${bounds.min} and ${bounds.max ?? "any number of"} rows; it has ${rows}.`,
    details: { collection, min: bounds.min, max: bounds.max, rows, asked }
  };
}

export function personDataRefusal(collection: string, label: string, index: number | undefined, paths: string[], whole: boolean): ItemRefusal {
  const details: Record<string, unknown> = { collection, paths };
  if (index !== undefined) {
    details.index = index;
  }
  return whole
    ? {
        code: "person-data",
        message: `The rows of '${label}' hold entries the person typed in Try it.`,
        hint: "Replacing the person's own entries needs their say; ask them, then remove those rows with try_it { action: 'edit_rows', rowAction: 'remove', force: true } first.",
        details
      }
    : {
        code: "person-data",
        message: `Row ${String(index)} of '${label}' holds entries the person typed in Try it.`,
        hint: "Removing the person's own entries needs their say; ask them, then pass force: true.",
        details
      };
}

// ---- reading ----------------------------------------------------------------------------------

/** The models listed as tried fields: not the root, not a row's copy or template, not a button, a static drawing or a plain group. */
export function listedModels(index: TriedIndex): RenderComponentModel[] {
  const out: RenderComponentModel[] = [];
  for (const model of index.models) {
    if (model.parentId === undefined || model.row !== undefined || index.rowKeys.has(model.id) || unfillableStaticKind(model) !== undefined) {
      continue;
    }
    if (kindOfNode(model) === "group") {
      continue;
    }
    out.push(model);
  }
  return out;
}

/** The labels of the options a choice holds, joined: what the person sees for the answer. */
export function displayOf(model: RenderComponentModel, kind: FieldKind, value: unknown): string | undefined {
  if (kind !== "choice" && kind !== "multichoice") {
    return undefined;
  }
  const labelOf = (option: string): string => model.optionState.items.find((item) => item.value === option)?.label ?? option;
  if (kind === "choice") {
    return typeof value === "string" && value !== "" ? cutString(labelOf(value), LABEL_CAP) : undefined;
  }
  const picked = Array.isArray(value)
    ? value.map(String)
    : typeof value === "object" && value !== null
      ? Object.entries(value as Record<string, unknown>)
          .filter(([, on]) => on === true)
          .map(([key]) => key)
      : [];
  return picked.length > 0 ? cutString(picked.map(labelOf).join(", "), VALUE_CAP) : undefined;
}

/** A value as a result echoes it: long strings cut. */
export function echoed(value: unknown): unknown {
  return typeof value === "string" ? cutString(value, VALUE_CAP) : value;
}

/** The error codes the tried form shows on a component now. */
function errorCodesOf(errors: readonly FormError[], id: string): string[] | undefined {
  const codes = [...new Set(errors.filter((error) => error.componentId === id).map((error) => error.code))];
  return codes.length > 0 ? codes : undefined;
}

/** `try_it { action: 'read' }`'s fields, paged. */
export function readFields(
  index: TriedIndex,
  typed: TypedAnswers,
  tried: ReadonlyMap<string, string>,
  options: { include: "visible" | "all"; offset: number; limit: number }
): { fields: TriedField[]; fieldCount: number } {
  const required = index.runtime.requiredMap();
  const errors = index.runtime.errors();
  const listed = listedModels(index).filter((model) => options.include === "all" || shownNow(index, model));
  const page = listed.slice(options.offset, options.offset + options.limit);
  const fields = page.map((model): TriedField => {
    const kind = kindOfNode(model);
    const visible = shownNow(index, model);
    const field: TriedField = {
      path: kind === "collection" ? collectionOf(model) : model.valuePath,
      componentId: model.id,
      label: cutString(model.label, LABEL_CAP),
      type: model.type,
      visible,
      required: required.get(model.id) === true,
      enabled: !model.disabled,
      readonly: model.readOnly || model.node.rules?.value !== undefined
    };
    if (visible) {
      if (kind === "collection") {
        const collection = collectionOf(model);
        const rows = rowsOf(typed.values, collection);
        field.value = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, echoed(value)])));
        let person = false;
        let assistant = false;
        for (const [row, entry] of rows.entries()) {
          for (const [key, value] of Object.entries(entry)) {
            const by = typedByOf(`${collection}[${row}].${key}`, value, typed, tried);
            person ||= by === "person";
            assistant ||= by === "assistant";
          }
        }
        if (person || assistant) {
          field.typedBy = person ? "person" : "assistant";
        }
      } else {
        const value = typed.values[model.valuePath];
        if (value !== undefined) {
          field.value = echoed(value);
          const display = displayOf(model, kind, value);
          if (display !== undefined) {
            field.display = display;
          }
          const by = typedByOf(model.valuePath, value, typed, tried);
          if (by !== undefined) {
            field.typedBy = by;
          }
        }
      }
    }
    const codes = errorCodesOf(errors, model.id);
    if (codes !== undefined) {
      field.errors = codes;
    }
    return field;
  });
  return { fields, fieldCount: listed.length };
}

// ---- problems --------------------------------------------------------------------------------

/** A problem's path and label from the component it names, when the tried form draws it. */
function locate(index: TriedIndex | undefined, componentId: string | undefined): { path?: string; label?: string } {
  if (index === undefined || componentId === undefined) {
    return {};
  }
  const model = index.modelById.get(componentId);
  if (model === undefined) {
    return {};
  }
  return { path: kindOfNode(model) === "collection" ? collectionOf(model) : model.valuePath, label: cutString(model.label, LABEL_CAP) };
}

/** Try it's check problems (the panel's) with their paths (at most 100; the count is the caller's). */
export function checkProblems(problems: readonly TryCheckProblem[], index: TriedIndex | undefined): TryProblem[] {
  return problems.slice(0, PROBLEMS_CAP).map((problem) => {
    const out: TryProblem = { label: cutString(problem.label, LABEL_CAP), message: cutString(problem.message, VALUE_CAP) };
    const where = locate(index, problem.componentId);
    if (where.path !== undefined) {
      out.path = where.path;
    }
    if (problem.componentId !== undefined) {
      out.componentId = problem.componentId;
    }
    return out;
  });
}

/**
 * How the tried form words an error: the component's own messages over its containers' over the
 * form's (as the renderer and the Try panel word one), else the engine's description of the code.
 */
function errorWords(root: ComponentNode, locale: string): (error: FormError) => string {
  const catalogs = new Map<string, ValidationMessageCatalog | undefined>();
  const walk = (node: ComponentNode, inherited?: ValidationMessageCatalog): void => {
    const layered = layerValidationMessages(readValidationMessages(node.configuration), inherited);
    catalogs.set(node.id, layered);
    for (const children of Object.values(node.children ?? {})) {
      for (const child of children ?? []) {
        walk(child, layered);
      }
    }
  };
  walk(root);
  const formCatalog = readValidationMessages(root.configuration);
  return (error) => {
    const message = resolveValidationMessage(error, (error.componentId !== undefined ? catalogs.get(error.componentId) : undefined) ?? formCatalog, locale);
    return message === error.code ? (ENGINE_VALIDATION_CODES.find((entry) => entry.code === error.code)?.label ?? message) : message;
  };
}

/** The blocking errors the tried form shows (a Submit's or a page move's), as problems; `ids` narrows them. */
export function errorProblems(index: TriedIndex, ids?: ReadonlySet<string>): { problems: TryProblem[]; problemCount: number } {
  const blocking = index.runtime.errors().filter((error) => (error.severity ?? "error") === "error" && (ids === undefined || (error.componentId !== undefined && ids.has(error.componentId))));
  const word = errorWords(index.runtime.formRoot(), index.locale);
  const problems = blocking.slice(0, PROBLEMS_CAP).map((error) => {
    const where = locate(index, error.componentId);
    const out: TryProblem = { label: where.label ?? "", message: cutString(word(error), VALUE_CAP) };
    if (where.path !== undefined) {
      out.path = where.path;
    }
    if (error.componentId !== undefined) {
      out.componentId = error.componentId;
    }
    return out;
  });
  return { problems, problemCount: blocking.length };
}

/** A required field left empty by a write, as a problem (the form would refuse it at Submit). */
export function requiredProblem(model: RenderComponentModel, path: string): TryProblem {
  const label = cutString(model.label, LABEL_CAP);
  return { path, componentId: model.id, label, message: `${label === "" ? path : label} is required.` };
}

/**
 * A journey page's heading: its title in the tried form's language (the page's string worded
 * through the tried form's translations at `journeys › <journey> › pages › <page> › title`), else the label of the first component it draws (the journey's own rule), else its id.
 */
export function pageTitle(page: JourneyPage, locale: string, id: string, runtime?: TriedRuntime, journeyId?: string): string {
  const sources = runtime !== undefined ? { translations: runtime.translations?.(), catalog: runtime.translationCatalog?.() } : undefined;
  let title: string | undefined = page.title;
  if (title !== undefined && sources !== undefined && journeyId !== undefined) {
    title = resolveText(title, addressOf.journeyPage(journeyId, page.id, "title"), locale, sources);
  }
  if ((title === undefined || title.trim() === "") && runtime !== undefined) {
    const first = journeyPageFormIds(page)[0];
    const node = first !== undefined ? runtime.componentTree().find(first) : undefined;
    const label = (node?.configuration as { label?: unknown } | undefined)?.label;
    title = typeof label === "string" && sources !== undefined && node !== undefined ? resolveText(label, addressOf.component(node.id, "label"), locale, sources) : undefined;
  }
  return cutString(title !== undefined && title.trim() !== "" ? title.trim() : id, LABEL_CAP);
}
