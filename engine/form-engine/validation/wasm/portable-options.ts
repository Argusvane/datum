import type { ComponentNode } from "../../core/schema/types.js";

/**
 * Choice answers held to their options in the portable kernel.
 *
 * Options from a wiring-time data source are not in the
 * definition, so the engine cannot know them. A host hands their values over as a
 * snapshot, the shape the PDF program's `optionSnapshot` already takes (`sourceId` -> the
 * items the source gave, `{ value, label }`), and {@link kernelCheckOptions} holds every
 * choice answer that will be stored to the options the person could have picked. It runs over
 * the values the fold left (`fold.submittable`), so a hidden answer the form still submits
 * (`hiddenValueBehavior: "retain"`) is checked like any other, and an answer the fold withheld
 * is not there to check.
 *
 * This module follows the portable rules in the header of `portable-kernel.ts`: top-level
 * `function` declarations only, every name prefixed and unique, no module constant read by a
 * function, no locale-sensitive API, records keyed by submitted text built without a
 * prototype and read through `hasOwnProperty`. It imports types only, so its functions call
 * nothing outside {@link PORTABLE_OPTIONS_FUNCTIONS}. A component's type is read as the engine
 * type the definition's `kinds` map gives it through a `baseOf` function the caller hands in (the
 * kernel's is `kernelKindBase` over the run's map, `core/schema/component-kinds.ts`), so the
 * map's reading lives in one place. Above all it imports nothing from
 * `portable-kernel.ts`, which lists this module's functions: an import cycle would leave
 * {@link PORTABLE_OPTIONS_FUNCTIONS} uninitialized whenever this module loads first. So the
 * path walk is a copy of the kernel's `kernelKnownKeyShapes` (data keys, data-scoping
 * containers, repeating sections at their collection path, a data grid among them),
 * the leaf reading a copy of the fold's `kernelFoldHoldsOwnAnswer`, and the source reading a
 * copy of `readSourceId`; `engine/tests/portable-options.test.ts` holds each copy to its
 * original (the walk over generated trees, the leaf reading by its text).
 *
 * The rules:
 *
 * - **What a choice is.** A component that holds an answer of its own (the fold's reading,
 *   {@link kernelOptionHoldsOwnAnswer}), is not one of the standard types whose control offers
 *   no options (`text`, `textarea`, `number`, `date`, `checkbox`, `file`: a stray `options`
 *   there must not refuse free text), and names a data source or carries at least one usable
 *   inline option. A `select`, `radio` or `checkboxes` with neither is not a choice and is not
 *   checked, as a server host had it: the renderer draws it with no options
 *   (`not-applicable`), so there is nothing to hold its answer to. A choice inside a data grid
 *   is a choice inside a repeating section.
 * - **Where its options come from.** A named source wins over the inline list, as the
 *   renderer resolves them. The source id is read as `readSourceId`
 *   (core/schema/data-source-capability.ts) reads it at its default path, `data.sourceId`: a
 *   non-empty string. A different path is a host's per-render choice (a capability's editor
 *   field, the React renderer's `sourcePathByComponentId`) that the definition does not
 *   carry, and the web component and PDF renderers read the default, so the kernel does too.
 *   The source's values are the snapshot's for that id when the snapshot has it as an own key
 *   holding a list. A source the snapshot does not have (no snapshot, one that is not a record,
 *   one lacking the id) or has as something other than a list FAILS CLOSED
 *   an answer that picks a value is refused with `option.sourceUnavailable`, naming the
 *   source, and the run log says which sources the snapshot lacked (`info`, always) and which
 *   answers were refused for it (`warn`); an answer that picks nothing (`""`, no ticked box) is
 *   no answer and passes. Before 2.10 such an answer went unchecked, a host's way to leave a
 *   source out of the check; it now leaves the answer refused. A snapshot entry that is a list
 *   allows exactly its items (an empty list allows nothing: `option.notAllowed`); an item's
 *   `value` counts when it is a string, or a finite number read as its string form (hosts that
 *   emit integer ids); any other item is skipped. With no source, the
 *   inline `configuration.options` entries the renderer would draw (`isInlineOption`: a string
 *   `value`, a label and description that are absent or a string; a definition's texts are
 *   strings, their translations live in its `translations`).
 * - **A source whose answers are free** (`data.answersFree: true` beside `data.sourceId`).
 *   A typeahead's suggestions are not the only answers allowed, so the
 *   author can say the snapshot is not the answer's list: the question is then NOT held to the
 *   snapshot (no `option.notAllowed` for a value outside it, no `option.sourceUnavailable` for
 *   a source it lacks, nothing logged for it), on both sides of the gate. The answer still has
 *   the shape of its kind (a `select` answer is a string, `checkboxes` an object of booleans)
 *   and the field's own constraints (length, pattern, required) still apply. Only the boolean
 *   `true` counts: absent, `false` or anything else leaves the check on and failing closed. A
 *   source shared by a free and a held question is still loaded and still binds the held one.
 * - **The answer's shape, standard types.** A `select` or `radio` answer is a string. A
 *   `checkboxes` answer is a plain object whose every entry is a boolean; only the keys set to
 *   `true` are picked, and a key set to `false` picks nothing, so it is ignored whether or not
 *   it is an option (the browser writes `false` for every unticked box, and a list that
 *   changed since leaves stale ones). `""`, `null` and `undefined` are no answer and pass.
 *   Anything else (a number, a boolean, a list, an object for a select, a `"true"` in a
 *   checkboxes object) is the wrong shape and refused, whether or not the values are checked.
 * - **The answer's shape, plugin types.** An extension type's answer is read for what it
 *   picks, as the PDF's `pickedValues` (render/pdf/pdf-values.ts) prints it, but only from the
 *   shapes a choice can take (fail closed): a string picks
 *   itself; a finite number or a boolean picks its string form (a rating writes `4` against
 *   options `"1"` to `"5"`); a list of those picks each item; a plain object whose every entry
 *   is a boolean picks the keys set to `true`. Any other shape (a nested object, a list holding
 *   a `null`, an object or a non-finite number, a record entry that is not a boolean) is the
 *   wrong shape and refused (`option.notAllowed`). Each value picked must be an option.
 * - **Which question a key answers.** A submitted key's exact shape, each entry index as `[]`
 *   as the kernel's `kernelKeyShape` writes it, names the questions stored there
 *   (`items[0].sku` -> `items[].sku`, `orders[2].status` -> a grid's field). A key whose shape
 *   the schema does not define at all (only a form that keeps unknown answers lets one this
 *   far) is matched index-free, every `[digits]` taken out as a server host did, so
 *   `province[0]` is held to `province`'s options. A key whose exact shape the schema defines
 *   only for something that is not a choice is not a choice answer.
 * - **Shared paths.** When several components store at one path, the answer is refused only
 *   when no choice stored there accepts it (each of them then reports it), and it is not
 *   checked at all when a plain text input (text, textarea) stores there too: a text field
 *   beside two selects may hold anything. Any other component sharing the key (a number, a
 *   file, a container, a grid, a section) leaves the check on
 * - **Rows posted whole.** The kernel's partition now flattens a list of rows posted at a
 *   repeating section's collection path (a data grid's included) into the flat keys they
 *   stand for (`items[0].sku`) before the fold, so these values normally arrive flat. The
 *   reading below stays as defence, for values that reach the check without that partition
 *   (a host or a run that calls it directly): the PDF's
 *   `readCollectionRows` prefers a list of row objects there over the flat keys. So when the
 *   value at such a key is a list, each item that is an object (not a list) is read as row
 *   `i` and each of its own keys `f` is checked as the key `<key>[i].f` (reported under that
 *   name), by every rule above, rows inside rows read the same way to a bounded depth (under
 *   the kernel's paths none arise: a section nested in an entry keeps its own collection path
 *   and is posted under its own key). A value there that is not a list is no row the readers
 *   take, and the kernel accepts it, so it is not a choice answer; nor is a list item that is
 *   not an object.
 * - **What comes back.** One `option.notAllowed` error per question refused (or
 *   `option.sourceUnavailable`, with `parameters.sourceId` too, for a question whose source the
 *   snapshot lacks), in document order: its component id, its path index-free (`items.sku`),
 *   and in `parameters.keys` the keys refused, each once, in the order they were met. A field
 *   of a data grid is reported as a section's field is.
 *   The check never throws on a malformed definition, answer or snapshot.
 */

/** One item of a data source's options as a host snapshots it: `DataSourceResult["items"]`'s shape. */
export interface KernelOptionItem {
  value: string;
  label?: unknown;
  description?: unknown;
  meta?: unknown;
}

/** The options a host resolved from its data sources, by source id. The PDF ABI's `optionSnapshot`. */
export interface KernelOptionSnapshot {
  [sourceId: string]: KernelOptionItem[];
}

/** A refused choice answer, in the ABI error contract: code, component, path, parameters. */
export interface KernelOptionCheck {
  /** `option.sourceUnavailable`: the question names a source the snapshot lacks (fails closed). */
  code: "option.notAllowed" | "option.sourceUnavailable";
  componentId: string;
  path: string;
  stage: "options";
  source: "wasm";
  /** `sourceId` is present exactly for `option.sourceUnavailable`. */
  parameters: { keys: string[]; sourceId?: string };
}

/** Where the check says what it could not check: the kernel's run log (`KernelLog`) fits. */
export interface KernelOptionLog {
  info(message: string, data?: unknown): void;
  /** Where a refusal for a source the snapshot lacks is said; the kernel's log has it. */
  warn?(message: string, data?: unknown): void;
}

/**
 * How a choice question takes its answer: `"one"` a string (`select`, `radio`), `"several"`
 * an object of booleans (`checkboxes`), `"plugin"` whatever an extension type writes, read for
 * the values it picks.
 */
export type KernelOptionKind = "one" | "several" | "plugin";

/** One choice question of a form: where its answer lives and what it may be. */
export interface KernelOptionQuestion {
  componentId: string;
  /** The value path with no entry index: `items.sku`. */
  path: string;
  /** The key shape the kernel's allowlist writes: `items[].sku`. */
  shape: string;
  kind: KernelOptionKind;
  /** The named data source, when one is set; its options then come from the snapshot. */
  sourceId?: string;
  /** The author declared the answers free (`data.answersFree: true`): the snapshot is not checked for this question. */
  free?: boolean;
  /** The inline option values, when no source is named. */
  options: string[];
}

/** The choice questions of a form and the indexes to find them by. Every record has no prototype. */
export interface KernelOptionQuestions {
  questions: KernelOptionQuestion[];
  /** Exact key shape -> indexes into `questions`. */
  byShape: Record<string, number[]>;
  /** Index-free path -> indexes into `questions`. */
  byPath: Record<string, number[]>;
  /** Every key shape the schema defines, exactly as `kernelKnownKeyShapes` lists them. */
  knownShapes: Record<string, true>;
  /** The shapes a plain text input (text, textarea) stores at too; any other sharer keeps a choice's check. */
  otherShapes: Record<string, true>;
  /** {@link otherShapes} index-free. */
  otherPaths: Record<string, true>;
  /** A repeating section's collection path (a data grid's among them): where rows may be posted whole. */
  rowShapes: Record<string, true>;
}

/** A node's configuration as a record, `{}` when it has none or a malformed one. */
export function kernelOptionConfiguration(node: unknown): Record<string, unknown> {
  if (node === null || typeof node !== "object") {
    return {};
  }
  const configuration = (node as { configuration?: unknown }).configuration;
  return configuration !== null && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as Record<string, unknown>)
    : {};
}

/** Mirrors `kernelDataKeyOf`: a node's valid data key, else its id (as it is, as the kernel reads it). */
export function kernelOptionDataKey(node: ComponentNode): string {
  const key = kernelOptionConfiguration(node).dataKey;
  return typeof key === "string" && /^[A-Za-z0-9_-]+$/.test(key) && !/^\d+$/.test(key) ? key : node.id;
}

/** Mirrors `kernelCollectionPathOf`: a repeating section's collection path as written, else its id; nothing for another node. */
export function kernelOptionCollectionPath(node: ComponentNode): string | undefined {
  const binding = node.collection;
  if (!binding) {
    return undefined;
  }
  const configured = binding.collectionPath;
  return typeof configured === "string" && configured.length > 0 ? configured : node.id;
}

/** Mirrors `kernelIsDataScopeContainer`: a `container` that does not say `scopeData: false`. */
export function kernelOptionScopesData(node: ComponentNode): boolean {
  return node.type === "container" && kernelOptionConfiguration(node).scopeData !== false;
}

/**
 * The fold's `kernelFoldHoldsOwnAnswer` (core/state/submittable-fold.ts), copied to the letter
 * (a test holds the two texts equal): whether a component holds an answer of its own.
 */
export function kernelOptionHoldsOwnAnswer(node: ComponentNode): boolean {
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

/** Mirrors the kernel's `kernelClaimsData`: a node with a place of its own in the data. */
export function kernelOptionClaimsData(node: ComponentNode): boolean {
  return (
    node.collection !== undefined ||
    kernelOptionScopesData(node) ||
    kernelOptionHoldsOwnAnswer(node)
  );
}

/**
 * Mirrors `isOptionalText` (core/schema/inline-options.ts): an inline option's label or
 * description is absent or a string (its translations live in the definition's map).
 */
export function kernelOptionIsText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/**
 * The inline option values a configuration declares, as `parseInlineOptions`
 * (core/schema/inline-options.ts) reads them: an entry that is not an option is skipped, a
 * list that is not a list holds none.
 */
export function kernelOptionInlineValues(configuration: Record<string, unknown>): string[] {
  const raw = configuration.options;
  const values: string[] = [];
  if (!Array.isArray(raw)) {
    return values;
  }
  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const option = entry as { value?: unknown; label?: unknown; description?: unknown };
    if (typeof option.value === "string" && kernelOptionIsText(option.label) && kernelOptionIsText(option.description)) {
      values.push(option.value);
    }
  }
  return values;
}

/**
 * Mirrors `readSourceId` (core/schema/data-source-capability.ts): the data source a
 * configuration names at `path` (default `data.sourceId`), a non-empty string, else nothing.
 */
export function kernelOptionSourceId(configuration: unknown, path?: string): string | undefined {
  const parts = (typeof path === "string" ? path : "data.sourceId").split(".");
  let cursor: unknown = configuration;
  for (let index = 0; index < parts.length; index += 1) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[parts[index] as string];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

/**
 * Whether a configuration declares the answers of its data source free (`data.answersFree`): only the boolean `true` does; the check then skips the snapshot for the question.
 */
export function kernelOptionSourceFree(configuration: unknown): boolean {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return false;
  }
  const data: unknown = (configuration as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  return (data as Record<string, unknown>).answersFree === true;
}

/**
 * Whether a node is a choice question, and how: its kind, its source or inline values. Nothing
 * for a node that holds no answer of its own, for a standard type that offers no options, and
 * for any node naming no source and carrying no usable option. `baseOf`, when given, reads the
 * node's type as an engine type (the definition's `kinds` map): a type with base `radio` is then
 * a choice of one, one with base `date` offers no options.
 */
export function kernelOptionChoiceOf(
  node: ComponentNode,
  baseOf?: (type: string) => string
): { kind: KernelOptionKind; sourceId?: string; free?: boolean; options: string[] } | undefined {
  if (node === null || typeof node !== "object" || typeof node.type !== "string" || !kernelOptionHoldsOwnAnswer(node)) {
    return undefined;
  }
  const type = typeof baseOf === "function" ? baseOf(node.type) : node.type;
  if (["text", "textarea", "number", "date", "checkbox", "file"].indexOf(type) >= 0) {
    return undefined;
  }
  const configuration = kernelOptionConfiguration(node);
  const sourceId = kernelOptionSourceId(configuration);
  // A named source wins: the inline list is dead data then.
  const options = sourceId !== undefined ? [] : kernelOptionInlineValues(configuration);
  if (sourceId === undefined && options.length === 0) {
    return undefined;
  }
  const kind: KernelOptionKind = type === "select" || type === "radio" ? "one" : type === "checkboxes" ? "several" : "plugin";
  if (sourceId === undefined) {
    return { kind, options };
  }
  return kernelOptionSourceFree(configuration) ? { kind, sourceId, free: true, options } : { kind, sourceId, options };
}

/**
 * Whether `node` is a plain text input (text or textarea): the only sharer of a data key that
 * lets a choice component's option check stand aside. Any
 * other component storing at the same key keeps the check.
 */
export function kernelOptionIsPlainText(node: unknown, baseOf?: (type: string) => string): boolean {
  if (node === null || typeof node !== "object") {
    return false;
  }
  const own = (node as { type?: unknown }).type;
  const type = typeof own === "string" && typeof baseOf === "function" ? baseOf(own) : own;
  return type === "text" || type === "textarea";
}

/**
 * The choice questions of the form under `root`, found with the kernel's own path walk
 * (`kernelKnownKeyShapes`), which this also copies whole into `knownShapes`: the same
 * children walked in the same order, a child whose id is not a string included, with the
 * paths the kernel's expressions build from it. Unlike the kernel it never throws on a
 * malformed tree: a children group that is not a list, or an entry that is not an object, is
 * passed over where the kernel would fail.
 */
export function kernelOptionQuestions(root: ComponentNode, baseOf?: (type: string) => string): KernelOptionQuestions {
  const questions: KernelOptionQuestion[] = [];
  const byShape = Object.create(null) as Record<string, number[]>;
  const byPath = Object.create(null) as Record<string, number[]>;
  const knownShapes = Object.create(null) as Record<string, true>;
  const otherShapes = Object.create(null) as Record<string, true>;
  const otherPaths = Object.create(null) as Record<string, true>;
  const rowShapes = Object.create(null) as Record<string, true>;

  function other(shape: string): void {
    otherShapes[shape] = true;
    otherPaths[shape.replace(/\[\]/g, "")] = true;
  }

  function add(
    componentId: string,
    shape: string,
    choice: { kind: KernelOptionKind; sourceId?: string; free?: boolean; options: string[] }
  ): void {
    const path = shape.replace(/\[\]/g, "");
    const question: KernelOptionQuestion = { componentId, path, shape, kind: choice.kind, options: choice.options };
    if (choice.sourceId !== undefined) {
      question.sourceId = choice.sourceId;
    }
    if (choice.free === true) {
      question.free = true;
    }
    const index = questions.length;
    questions.push(question);
    if (Object.prototype.hasOwnProperty.call(byShape, shape)) {
      byShape[shape]!.push(index);
    } else {
      byShape[shape] = [index];
    }
    if (Object.prototype.hasOwnProperty.call(byPath, path)) {
      byPath[path]!.push(index);
    } else {
      byPath[path] = [index];
    }
  }

  function walkChildren(node: ComponentNode, prefix: string): void {
    const children = node.children;
    if (children === null || typeof children !== "object") {
      return;
    }
    const groups = Object.keys(children);
    for (let slot = 0; slot < groups.length; slot += 1) {
      const group: unknown = (children as Record<string, unknown>)[groups[slot] as string];
      if (!Array.isArray(group)) {
        continue;
      }
      for (let index = 0; index < group.length; index += 1) {
        const child: unknown = group[index];
        if (child !== null && typeof child === "object") {
          walk(child as ComponentNode, prefix);
        }
      }
    }
  }

  function walk(node: ComponentNode, prefix: string): void {
    const collection = kernelOptionCollectionPath(node);
    let childPrefix: string;
    if (collection !== undefined) {
      // A collection path written with brackets defines nothing, nor anything under it.
      const written = String(collection);
      if (written.indexOf("[") >= 0 || written.indexOf("]") >= 0) {
        return;
      }
      knownShapes[written] = true;
      rowShapes[written] = true;
      childPrefix = written + "[]";
    } else {
      // The kernel's expressions, kept as they are: an id that is not a string reads as it does there.
      const path = prefix.length > 0 ? prefix + "." + kernelOptionDataKey(node) : kernelOptionDataKey(node);
      if (kernelOptionClaimsData(node)) {
        knownShapes[path] = true;
        const choice = kernelOptionChoiceOf(node, baseOf);
        if (choice !== undefined) {
          add(String(node.id), String(path), choice);
        } else if (kernelOptionIsPlainText(node, baseOf)) {
          other(String(path));
        }
      }
      childPrefix = kernelOptionScopesData(node) ? path : prefix;
    }
    walkChildren(node, childPrefix);
  }

  if (root !== null && typeof root === "object") {
    walkChildren(root, "");
  }
  return { questions, byShape, byPath, knownShapes, otherShapes, otherPaths, rowShapes };
}

/**
 * Mirrors `kernelKeyShape`: each entry index (digits, no leading zero) as `[]`, or nothing for
 * a key with any other bracket in it.
 */
export function kernelOptionKeyShape(key: string): string | undefined {
  if (/[[\]]/.test(key.replace(/\[(?:0|[1-9][0-9]*)\]/g, ""))) {
    return undefined;
  }
  return key.replace(/\[(?:0|[1-9][0-9]*)\]/g, "[]");
}

/** Whether a value is a plain record: what JSON carries for an object, never a list, a Date or a Map. */
export function kernelOptionIsRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * The option values an answer picks, or `null` for an answer of the wrong shape. No answer
 * (`undefined`, `null`, `""`) picks nothing. A plugin type's answer may be a text, a finite
 * number, a boolean, a list of those or a record of booleans; any other shape is
 * `null`, so it is refused.
 */
export function kernelOptionPicked(kind: KernelOptionKind, value: unknown): string[] | null {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const picked: string[] = [];
  if (kind === "plugin") {
    // Fail closed: a plugin type's answer is a string, a
    // finite number, a boolean, a list of those, or a record of booleans; a nested object, a
    // list holding one, a null item or a record entry of any other kind is refused whole.
    if (typeof value === "string") {
      picked.push(value);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return null;
      }
      picked.push(String(value));
    } else if (typeof value === "boolean") {
      picked.push(String(value));
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index];
        if (typeof item === "string") {
          picked.push(item);
        } else if ((typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean") {
          picked.push(String(item));
        } else {
          return null;
        }
      }
    } else if (kernelOptionIsRecord(value)) {
      // Only the keys set to `true` pick; an entry of any other kind than a boolean is refused.
      const keys = Object.keys(value as Record<string, unknown>);
      for (let index = 0; index < keys.length; index += 1) {
        const ticked = (value as Record<string, unknown>)[keys[index] as string];
        if (ticked === true) {
          picked.push(keys[index] as string);
        } else if (ticked !== false) {
          return null;
        }
      }
    } else {
      return null;
    }
    return picked;
  }
  if (typeof value === "string") {
    return kind === "one" ? [value] : null;
  }
  if (kind === "one" || !kernelOptionIsRecord(value)) {
    return null;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const ticked = (value as Record<string, unknown>)[key];
    if (ticked === true) {
      picked.push(key);
    } else if (ticked !== false) {
      return null;
    }
  }
  return picked;
}

/**
 * The values a snapshot allows for a source, as a record without a prototype; `undefined`
 * when the snapshot does not have the source as an own key holding a list (the source is then
 * unavailable, and an answer that picks from it is refused: `option.sourceUnavailable`). A list allows exactly its items, an empty one nothing; an item's value counts when
 * it is a string, or a finite number read as its string form.
 */
export function kernelOptionSnapshotValues(snapshot: unknown, sourceId: string): Record<string, true> | undefined {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, sourceId)) {
    return undefined;
  }
  const items: unknown = (snapshot as Record<string, unknown>)[sourceId];
  if (!Array.isArray(items)) {
    return undefined;
  }
  const allowed = Object.create(null) as Record<string, true>;
  for (let index = 0; index < items.length; index += 1) {
    const item: unknown = items[index];
    if (item === null || typeof item !== "object") {
      continue;
    }
    const value = (item as { value?: unknown }).value;
    if (typeof value === "string") {
      allowed[value] = true;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      allowed[String(value)] = true;
    }
  }
  return allowed;
}

/**
 * Holds every choice answer in `values` to its options and returns one `option.notAllowed`
 * error per question refused, in document order. `values` are the answers that will be stored:
 * the fold's `submittable`, keyed as submitted. `snapshot` is the host's
 * `context.optionSnapshot`, or `undefined` when it sent none (then an answer to a question
 * bound to a source is refused, `option.sourceUnavailable`; inline options and standard answer
 * shapes are checked as ever). `log`, when given, hears once at `info` which questions name a
 * source the snapshot does not have, and at `warn` which answers were refused for it. The full
 * set of rules is in this module's header. `questions`, when given, are the form's choice questions
 * already worked out (`kernelOptionQuestions(root)`, plain data a host may keep per definition and
 * must not write to); the answer is the same with or without them.
 */
export function kernelCheckOptions(
  root: ComponentNode,
  values: Record<string, unknown>,
  snapshot: KernelOptionSnapshot | undefined,
  log?: KernelOptionLog,
  questions?: KernelOptionQuestions,
  baseOf?: (type: string) => string
): KernelOptionCheck[] {
  const errors: KernelOptionCheck[] = [];
  if (root === null || typeof root !== "object" || values === null || typeof values !== "object") {
    return errors;
  }
  const found = questions !== undefined && questions !== null ? questions : kernelOptionQuestions(root, baseOf);
  if (found.questions.length === 0) {
    return errors;
  }
  // What each question allows, worked out once per source and per inline list: a record
  // without a prototype, or `undefined` for a source the snapshot does not have.
  const bySource = Object.create(null) as Record<string, Record<string, true> | undefined>;
  const allowedOf: Array<Record<string, true> | undefined> = [];
  const unchecked: Array<{ componentId: string; path: string; sourceId: string }> = [];
  for (let index = 0; index < found.questions.length; index += 1) {
    const question = found.questions[index] as KernelOptionQuestion;
    if (question.sourceId !== undefined && question.free === true) {
      // Answers declared free: the snapshot is no list for this question.
      allowedOf.push(undefined);
    } else if (question.sourceId !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(bySource, question.sourceId)) {
        bySource[question.sourceId] = kernelOptionSnapshotValues(snapshot, question.sourceId);
      }
      const allowed = bySource[question.sourceId];
      allowedOf.push(allowed);
      if (allowed === undefined) {
        unchecked.push({ componentId: question.componentId, path: question.path, sourceId: question.sourceId });
      }
    } else {
      const allowed = Object.create(null) as Record<string, true>;
      for (let option = 0; option < question.options.length; option += 1) {
        allowed[question.options[option] as string] = true;
      }
      allowedOf.push(allowed);
    }
  }
  if (unchecked.length > 0 && log !== undefined && log !== null && typeof log.info === "function") {
    log.info("choice answers not held to their options: the option snapshot lacks their sources", { unchecked });
  }

  const refused = Object.create(null) as Record<string, string[]>;
  const refusedCode = Object.create(null) as Record<string, string>;
  const seen = Object.create(null) as Record<string, true>;

  /** The code an answer is refused with at one question, or `""` when the question accepts it. */
  function refusal(which: number, value: unknown): string {
    const question = found.questions[which] as KernelOptionQuestion;
    const picked = kernelOptionPicked(question.kind, value);
    if (picked === null) {
      return "option.notAllowed";
    }
    if (question.free === true) {
      // Free answers: the shape was held above, the snapshot is not consulted.
      return "";
    }
    const allowed = allowedOf[which];
    if (allowed === undefined) {
      // The source is not in the snapshot: an answer that picks something cannot be held to it.
      return picked.length > 0 ? "option.sourceUnavailable" : "";
    }
    for (let pick = 0; pick < picked.length; pick += 1) {
      if (!Object.prototype.hasOwnProperty.call(allowed, picked[pick] as string)) {
        return "option.notAllowed";
      }
    }
    return "";
  }

  function visit(key: string, value: unknown, depth: number): void {
    // An entry holding `undefined` is not an answer: JSON would not have carried it.
    if (value === undefined) {
      return;
    }
    const shape = kernelOptionKeyShape(key);
    // Rows posted whole at a collection path: each row's keys as the flat keys they stand for.
    if (shape !== undefined && Object.prototype.hasOwnProperty.call(found.rowShapes, shape) && Array.isArray(value) && depth < 8) {
      for (let row = 0; row < value.length; row += 1) {
        const entry: unknown = value[row];
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const fields = Object.keys(entry);
        for (let field = 0; field < fields.length; field += 1) {
          const name = fields[field] as string;
          visit(key + "[" + row + "]." + name, (entry as Record<string, unknown>)[name], depth + 1);
        }
      }
    }
    let matched: number[] | undefined;
    if (shape !== undefined && Object.prototype.hasOwnProperty.call(found.knownShapes, shape)) {
      // Defined by the schema: a choice answer only where no other component stores too.
      if (Object.prototype.hasOwnProperty.call(found.byShape, shape) && !Object.prototype.hasOwnProperty.call(found.otherShapes, shape)) {
        matched = found.byShape[shape];
      }
    } else {
      const path = key.replace(/\[\d+\]/g, "");
      if (Object.prototype.hasOwnProperty.call(found.byPath, path) && !Object.prototype.hasOwnProperty.call(found.otherPaths, path)) {
        matched = found.byPath[path];
      }
    }
    if (matched === undefined) {
      return;
    }
    const codes: string[] = [];
    for (let at = 0; at < matched.length; at += 1) {
      const code = refusal(matched[at] as number, value);
      if (code === "") {
        return;
      }
      codes.push(code);
    }
    for (let at = 0; at < matched.length; at += 1) {
      const label = String(matched[at]);
      if (!Object.prototype.hasOwnProperty.call(refusedCode, label)) {
        refusedCode[label] = codes[at] as string;
      }
      const mark = label + "\u0000" + key;
      if (Object.prototype.hasOwnProperty.call(seen, mark)) {
        continue;
      }
      seen[mark] = true;
      if (Object.prototype.hasOwnProperty.call(refused, label)) {
        refused[label]!.push(key);
      } else {
        refused[label] = [key];
      }
    }
  }

  const keys = Object.keys(values);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    visit(key, values[key], 0);
  }
  const unavailable: Array<{ componentId: string; path: string; sourceId: string; keys: string[] }> = [];
  for (let index = 0; index < found.questions.length; index += 1) {
    const label = String(index);
    if (Object.prototype.hasOwnProperty.call(refused, label)) {
      const question = found.questions[index] as KernelOptionQuestion;
      const keys = refused[label] as string[];
      // One error for the question, every key it refused listed.
      const groups: Array<{ path: string; keys: string[] }> = [{ path: question.path, keys }];
      for (let at = 0; at < groups.length; at += 1) {
        const group = groups[at] as { path: string; keys: string[] };
        if (refusedCode[label] === "option.sourceUnavailable") {
          errors.push({
            code: "option.sourceUnavailable",
            componentId: question.componentId,
            path: group.path,
            stage: "options",
            source: "wasm",
            parameters: { keys: group.keys, sourceId: question.sourceId as string }
          });
          unavailable.push({ componentId: question.componentId, path: group.path, sourceId: question.sourceId as string, keys: group.keys });
        } else {
          errors.push({
            code: "option.notAllowed",
            componentId: question.componentId,
            path: group.path,
            stage: "options",
            source: "wasm",
            parameters: { keys: group.keys }
          });
        }
      }
    }
  }
  if (unavailable.length > 0 && log !== undefined && log !== null && typeof log.warn === "function") {
    log.warn("choice answers refused: the option snapshot lacks their sources", { unavailable });
  }
  return errors;
}

/** This module's functions, for the kernel's `PORTABLE_KERNEL_FUNCTIONS`. */
export const PORTABLE_OPTIONS_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  kernelOptionConfiguration,
  kernelOptionDataKey,
  kernelOptionCollectionPath,
  kernelOptionScopesData,
  kernelOptionHoldsOwnAnswer,
  kernelOptionClaimsData,
  kernelOptionIsText,
  kernelOptionInlineValues,
  kernelOptionSourceId,
  kernelOptionSourceFree,
  kernelOptionChoiceOf,
  kernelOptionIsPlainText,
  kernelOptionQuestions,
  kernelOptionKeyShape,
  kernelOptionIsRecord,
  kernelOptionPicked,
  kernelOptionSnapshotValues,
  kernelCheckOptions
];
