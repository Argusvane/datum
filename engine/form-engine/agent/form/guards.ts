/**
 * Field references and the per-path write guards.
 * A reference is resolved as the exact value path `describe_form` lists, then as a component
 * id, then as a row-entry path (`items[2].qty`, the template field found through the row key);
 * anything else is `unknown-field` with up to five suggestions. The guards sit in front of the
 * guard-free runtime (`setValues` stores anything): kind, calculation, effective state, the
 * person's caret, row existence and the data-sources feature, each a refusal with its
 * exact hint. A journey presentation's own value field (an `@<presentation>.<id>` path)
 * is written like a form field on the page the person sees; on
 * another page it is `not-writable { reason: "presentation" }`, whose hint names `navigate`. The
 * presentation's other `@` nodes (its container, own layouts and drawings, the placeholders of a
 * form field) keep the `presentation` refusal.
 */

import { collectionPathOf } from "../../core/tree/data-scope.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";
import type { FormRuntime } from "../../runtime/browser/form-runtime.js";
import type { FieldKind } from "../../registry/kinds.js";
import { isNestedCollection, kindOf, unfillableStaticKind, writabilityOfState, type UnfillableKind, type WhyNotWritable, type WritabilityPlace } from "../answers/index.js";
import type { Refusal } from "./coerce.js";
import type { RenderMemo } from "./describe.js";

/** The runtime's own path grammar, at most 256 characters. */
export const PATH_PATTERN = /^@?[A-Za-z0-9_-]+(\[\d+\])?(\.[A-Za-z0-9_-]+(\[\d+\])?)*$/u;
export const PATH_MAX = 256;
export const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;
export const COMPONENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
export const COMPONENT_ID_MAX = 128;

const SUGGESTIONS_CAP = 5;
const SUGGESTION_DISTANCE = 3;

/** What a reference must look like; `undefined` when it fits, else the `expected` wording of a `bad-input` problem. */
export function refProblem(ref: unknown): string | undefined {
  if (typeof ref !== "string" || ref.length === 0) {
    return "a field path or id";
  }
  if (ref.length > PATH_MAX) {
    return `a field path of at most ${PATH_MAX} characters`;
  }
  if (!PATH_PATTERN.test(ref)) {
    return "a field path: segments of letters, digits, _ and -, joined by dots, with an optional [n] row index";
  }
  return undefined;
}

export function localeProblem(locale: unknown): string | undefined {
  if (typeof locale !== "string" || locale.length === 0) {
    return "a locale code such as 'en' or 'fr-CA'";
  }
  return LOCALE_PATTERN.test(locale) ? undefined : "a locale code such as 'en' or 'fr-CA'";
}

/** A row-entry path taken apart: `items[2].qty` → the collection, the row and the key within it. */
export interface RowPath {
  collection: string;
  index: number;
  key: string;
}

export function rowPathOf(path: string): RowPath | undefined {
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

export interface ResolvedRef {
  /** The model the reference names: a field, a row cell, or the row template field for a row that does not exist. */
  model: RenderComponentModel;
  /** The value path the write goes to. */
  path: string;
  id: string;
  /** Set when the path names a cell of a collection row (existing or not). */
  row?: RowPath & { ownerId: string; exists: boolean };
}

/** The collection-bound container whose entries live at `collection`. */
export function collectionModel(memo: RenderMemo, collection: string): RenderComponentModel | undefined {
  return memo.models.find((model) => model.rows !== undefined && (collectionPathOf(model.node) ?? model.valuePath) === collection);
}

/** The row template field keyed `key` inside `owner`. */
export function templateField(memo: RenderMemo, owner: RenderComponentModel, key: string): RenderComponentModel | undefined {
  for (const node of memo.tree.descendantsOf(owner.id)) {
    if (memo.rowKeys.get(node.id) === key) {
      return memo.modelById.get(node.id);
    }
  }
  return undefined;
}

/** The collection a row template field belongs to, when it is one. */
export function ownerOfTemplate(memo: RenderMemo, model: RenderComponentModel): RenderComponentModel | undefined {
  if (!memo.rowKeys.has(model.id) || model.row !== undefined) {
    return undefined;
  }
  let current = model.parentId !== undefined ? memo.modelById.get(model.parentId) : undefined;
  while (current !== undefined) {
    if (current.rows !== undefined) {
      return current;
    }
    current = current.parentId !== undefined ? memo.modelById.get(current.parentId) : undefined;
  }
  return undefined;
}

function rowRef(memo: RenderMemo, runtime: FormRuntime, model: RenderComponentModel, row: RowPath, ownerId: string): ResolvedRef {
  const exists = row.index < runtime.rows(row.collection).length;
  const cell = memo.modelByPath.get(`${row.collection}[${row.index}].${row.key}`);
  return { model: cell ?? model, path: `${row.collection}[${row.index}].${row.key}`, id: model.id, row: { ...row, ownerId, exists } };
}

/** Resolves a field reference in its documented order; `undefined` when nothing matches. */
export function resolveRef(ref: string, memo: RenderMemo, runtime: FormRuntime): ResolvedRef | undefined {
  const byPath = memo.modelByPath.get(ref);
  if (byPath !== undefined && byPath.parentId !== undefined) {
    if (byPath.row !== undefined) {
      const row = rowPathOf(ref);
      if (row !== undefined) {
        return rowRef(memo, runtime, byPath, row, byPath.row.ownerId);
      }
    }
    const owner = ownerOfTemplate(memo, byPath);
    if (owner !== undefined && !isNestedCollection(byPath)) {
      // A row template field named by its bare path: the first row's cell.
      const key = memo.rowKeys.get(byPath.id) as string;
      return rowRef(memo, runtime, byPath, { collection: collectionPathOf(owner.node) ?? owner.valuePath, index: 0, key }, owner.id);
    }
    return { model: byPath, path: byPath.valuePath, id: byPath.id };
  }
  const byId = memo.modelById.get(ref);
  if (byId !== undefined && byId.parentId !== undefined) {
    const owner = ownerOfTemplate(memo, byId);
    if (owner !== undefined && !isNestedCollection(byId)) {
      const key = memo.rowKeys.get(byId.id) as string;
      return rowRef(memo, runtime, byId, { collection: collectionPathOf(owner.node) ?? owner.valuePath, index: 0, key }, owner.id);
    }
    return { model: byId, path: byId.valuePath, id: byId.id };
  }
  const row = rowPathOf(ref);
  if (row !== undefined) {
    const owner = collectionModel(memo, row.collection);
    const template = owner !== undefined ? templateField(memo, owner, row.key) : undefined;
    if (owner !== undefined && template !== undefined) {
      return rowRef(memo, runtime, template, row, owner.id);
    }
  }
  return undefined;
}

/** Levenshtein distance, for the `did you mean` suggestions. */
export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
    }
    previous = current;
  }
  return previous[cols - 1] as number;
}

/** Up to five paths or ids within an edit distance of three of `ref`, nearest first. */
export function suggestionsFor(ref: string, memo: RenderMemo): string[] {
  const candidates = new Set<string>();
  for (const model of memo.models) {
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

export function unknownField(ref: string, memo: RenderMemo): Refusal {
  const suggestions = suggestionsFor(ref, memo);
  return {
    code: "unknown-field",
    message: `No field has the path or id '${ref}'.`,
    hint: `Use a \`path\` from describe_form; did you mean ${suggestions.length > 0 ? suggestions.join(", ") : "one of the listed paths"}?`,
    details: { ref, suggestions }
  };
}

const NOT_WRITABLE_HINTS: Readonly<Record<WhyNotWritable, string>> = {
  hidden: "The form hides this field right now; another answer may reveal it (describe_form scope 'all' shows the hidden ones).",
  disabled: "The form does not allow changing this field; tell the person.",
  readonly: "The form does not allow changing this field; tell the person.",
  calculated: "The form works this value out itself; write the fields it depends on.",
  unfillable: "Files, signatures, buttons and nested tables must be handled by the person; ask them.",
  group: "This is a container; write its fields' paths instead.",
  presentation: "This field belongs to the page's presentation and cannot be written by an assistant."
};

export function notWritable(path: string, reason: WhyNotWritable, unfillableKind?: UnfillableKind): Refusal {
  const details: Record<string, unknown> = { path, reason };
  if (unfillableKind !== undefined) {
    details.unfillableKind = unfillableKind;
  }
  const what =
    reason === "hidden"
      ? "is hidden right now"
      : reason === "disabled"
        ? "is disabled"
        : reason === "readonly"
          ? "is read-only"
          : reason === "calculated"
            ? "is worked out by the form"
            : reason === "group"
              ? "is a container"
              : reason === "presentation"
                ? "belongs to the page's presentation"
                : `cannot be filled by an assistant (${unfillableKind ?? "unfillable"})`;
  return { code: "not-writable", message: `The field '${path}' ${what}.`, hint: NOT_WRITABLE_HINTS[reason], details };
}

export function fieldInUse(path: string): Refusal {
  return {
    code: "field-in-use",
    message: `The person is typing in '${path}' right now.`,
    hint: "Write the other fields now and retry this one, or call begin_session to pause the person's typing first.",
    details: { path }
  };
}

export function noSuchRow(collection: string, index: number, rows: number): Refusal {
  return {
    code: "no-such-row",
    message: `'${collection}' has ${rows} rows; there is no row ${index}.`,
    hint: `The table has ${rows} rows; add one with edit_rows, or pass the whole table as an array to set_answers.`,
    details: { collection, index, rows }
  };
}

export function rowsLocked(collection: string, operation: "add" | "remove" | "replace"): Refusal {
  const done = operation === "add" ? "added" : operation === "remove" ? "removed" : "replaced";
  return {
    code: "rows-locked",
    message: `Rows of '${collection}' cannot be ${done}.`,
    hint: `Rows cannot be ${done} here; tell the person.`,
    details: { collection, operation }
  };
}

export function rowsLimit(collection: string, min: number, max: number | null, rows: number, asked: number): Refusal {
  return {
    code: "rows-limit",
    message: `'${collection}' would hold ${asked} rows, outside its bounds.`,
    hint: `The table allows between ${min} and ${max ?? "any number of"} rows; it has ${rows}.`,
    details: { collection, min, max, rows, asked }
  };
}

export function featureOff(feature: string): Refusal {
  return {
    code: "feature-off",
    message: `This page's features list leaves out "${feature}".`,
    hint: "This page does not allow that; tell the person instead of retrying.",
    details: { feature }
  };
}

export interface WriteGuardContext {
  /** The caret path the person is typing in, when any and outside a session. */
  focused: string | undefined;
  dataSourcesAllowed: boolean;
}

/** Whether the kind is one `set_answers` writes at all. */
export function fillableKind(kind: FieldKind): boolean {
  return kind !== "group" && kind !== "file" && kind !== "signature";
}

/**
 * The per-path guards in their documented order, the first that fails answering: kind (group / file /
 * signature / button / static / nested collection), calculation, effective hidden / disabled /
 * readonly, the person's caret, a row past the end, a source-backed field with data sources
 * left out. `undefined` when the write may go on to coercion.
 */
export function writeGuard(resolved: ResolvedRef, memo: RenderMemo, runtime: FormRuntime, context: WriteGuardContext): Refusal | undefined {
  const { model, path } = resolved;
  const kind = kindOf(model, memo.kinds);
  // The effective state, read fresh (the memo's `visible` is the same reading at its revision);
  // the shared answers module judges it after the static reasons no state lifts.
  const stateId = resolved.row !== undefined ? resolved.row.ownerId : model.id;
  const effective = runtime.effectiveState(stateId) ?? runtime.effectiveState(model.id);
  const cellEffective = resolved.row !== undefined ? runtime.effectiveState(model.id) : undefined;
  const writability = writabilityOfState(model, kind, effective, cellEffective, placeOf(model, runtime));
  if (!writability.writable) {
    // An own value field refused for its place is on another page: the hint names navigate.
    if (writability.why === "presentation" && isOwnValueField(model, runtime)) {
      return presentationField(path);
    }
    return notWritable(path, writability.why as WhyNotWritable, writability.unfillableKind);
  }
  if (context.focused !== undefined && context.focused === path) {
    return fieldInUse(path);
  }
  // A whole-table write replaces the row the person is typing in ("or such a control in a
  // row of that table"), so the caret inside any of its rows refuses the table's path.
  if (context.focused !== undefined && kind === "collection" && context.focused.startsWith(`${collectionPathOf(model.node) ?? model.valuePath}[`)) {
    return fieldInUse(context.focused);
  }
  if (resolved.row !== undefined && !resolved.row.exists) {
    return noSuchRow(resolved.row.collection, resolved.row.index, runtime.rows(resolved.row.collection).length);
  }
  if (model.optionState.sourceId !== undefined && !context.dataSourcesAllowed) {
    return featureOff("data-sources");
  }
  return undefined;
}

/**
 * Whether a model is a journey presentation's own value field: a node of kind
 * `"field"` whose answer the running presentation keeps under its own `@` key (`ownKeys`). The
 * presentation's other `@` nodes are not: its container, its own layouts and static drawings,
 * and the placeholders that stand for a form field drawn on the page (that field is written by
 * its own path).
 */
export function isOwnValueField(model: RenderComponentModel, runtime: FormRuntime): boolean {
  return model.valuePath.startsWith("@") && runtime.presentationIndex()?.ownKeys[model.id] === model.valuePath;
}

/**
 * Whether a model is a journey presentation's own value field drawn on the page shown now: the running presentation places its node on the
 * journey's current page. The render memo holds every page's own nodes, so the page is read
 * from the presentation index, never from the memo.
 */
export function ownFieldOnPage(model: RenderComponentModel, runtime: FormRuntime): boolean {
  if (!isOwnValueField(model, runtime)) {
    return false;
  }
  const page = runtime.presentationIndex()?.pageOf[model.id];
  return page !== undefined && page === runtime.journeyView()?.pageId;
}

/** The place the shared writability module reads for an `@` model (`answers/writability.ts`). */
export function placeOf(model: RenderComponentModel, runtime: FormRuntime): WritabilityPlace | undefined {
  return model.valuePath.startsWith("@") ? { ownFieldOnPage: ownFieldOnPage(model, runtime) } : undefined;
}

/**
 * The refusal for a presentation's own value field on another page of the journey: its hint names navigate. Any other `@` node keeps the
 * `presentation` wording of {@link notWritable} (nothing there is ever the agent's to write).
 */
export function presentationField(path: string): Refusal {
  return {
    code: "not-writable",
    message: `The field '${path}' belongs to another page of the journey.`,
    hint: "This field belongs to another page of the journey; move there with navigate, then write it.",
    details: { path, reason: "presentation" }
  };
}

export { isNestedCollection };
