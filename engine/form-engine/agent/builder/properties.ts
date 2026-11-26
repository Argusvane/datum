/**
 * Property paths for `set_properties`: how a
 * spelling becomes a configuration path or a rule key, which names the tool refuses (the ones
 * another tool owns), the path hygiene shared with `add_components` (no prototype names), the
 * value kinds the inspector declares (a checkbox's `"true"`, a number's numeral, an option
 * list given as strings), and the write itself mirrored on a copy of the node so the checks run
 * over the would-be component before the controller sees anything.
 *
 * Option lists are normalised here for both `set_properties` and `add_components`: a string
 * becomes `{ value, label }` with the value derived from the label, every entry is round-tripped through the reader the runtime uses, and the derived values
 * are named in one warning per component.
 *
 * Pure over its arguments: nothing here reads the page or writes the tree.
 */
import { isInlineOption } from "../../core/schema/inline-options.js";
import { isPrototypeName } from "../../core/tree/prototype-names.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { BuilderController } from "../../builder/controller/builder-controller.js";
import type { InspectorControl } from "../../builder/property-editor/inspector-model.js";
import { ToolRefusal } from "../tool-types.js";
import { RULE_KEYS } from "./formulas.js";
import type { RuleKey } from "./types.js";

/** A property path's caps. */
export const PROPERTY_PATH_CHARS = 512;
export const PROPERTY_PATH_SEGMENTS = 32;

/** What a bad-input refusal lists. */
export interface InputProblem {
  key: string;
  expected: string;
}

/** The registrar's `bad-input` shape, raised by the catalogue for what the schema subset cannot say. */
export function badInput(problems: readonly InputProblem[], message = "The arguments do not fit the tool's schema."): ToolRefusal {
  return new ToolRefusal("bad-input", message, "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.", {
    problems: problems.map((problem) => ({ ...problem }))
  });
}

/** The `too-large { what: "input" }` refusal for a list over its cap. */
export function tooLarge(key: string, limit: number, got: number): ToolRefusal {
  return new ToolRefusal("too-large", `${key} carries ${got} entries, over the ${limit} entry limit.`, `Send fewer items per call (at most ${limit} for ${key}) and call again for the rest.`, {
    what: "input",
    limit,
    got,
    key
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isPrototypeName };

/**
 * The first prototype-named key anywhere under `value` (objects and arrays, recursively), as
 * `<key>.<path>`; `undefined` when there is none. Walked with an explicit stack and a seen set,
 * so a deep or cyclic value is answered, never a RangeError.
 */
export function prototypeKeyIn(value: unknown, key: string): string | undefined {
  const stack: Array<{ value: unknown; key: string }> = [{ value, key }];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const next = stack.pop() as { value: unknown; key: string };
    if (typeof next.value !== "object" || next.value === null || seen.has(next.value)) {
      continue;
    }
    seen.add(next.value);
    if (Array.isArray(next.value)) {
      next.value.forEach((item, index) => stack.push({ value: item, key: `${next.key}[${index}]` }));
      continue;
    }
    // Own keys only, `__proto__` included when JSON.parse made it an own property.
    for (const name of Object.keys(next.value)) {
      const child = `${next.key}.${name}`;
      if (isPrototypeName(name)) {
        return child;
      }
      stack.push({ value: (next.value as Record<string, unknown>)[name], key: child });
    }
  }
  return undefined;
}

/** The hygiene refusal. */
export function prototypeRefusal(key: string): ToolRefusal {
  return badInput([{ key, expected: "a property name that is not a prototype name" }]);
}

// ---- option lists ----------------------------------------------------------------------------

/** A label turned into an option value: trimmed, NFC, lower case, spaces to `_`, only `[a-z0-9_-]` kept. */
function deriveValue(label: string): string {
  return label
    .trim()
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "");
}

/** What normalising one option list did. */
export interface NormalisedOptions {
  options: Array<{ value: string; label: unknown; description?: unknown }>;
  /** The values derived from string entries, in order. */
  derived: string[];
}

/**
 * An option list as the agent sent it (strings or `{ value, label }` pairs) as the inline
 * options the runtime reads. Throws `bad-input` on an entry that is neither (keyed
 * `<key>[<i>]`), after the round trip the runtime's reader makes (`isInlineOption`).
 */
export function normaliseOptions(raw: unknown, key: string): NormalisedOptions {
  if (!Array.isArray(raw)) {
    throw badInput([{ key, expected: "an array of strings or { value, label } objects" }]);
  }
  const taken = new Set<string>();
  for (const entry of raw) {
    if (isRecord(entry) && typeof entry.value === "string") {
      taken.add(entry.value);
    }
  }
  const options: NormalisedOptions["options"] = [];
  const derived: string[] = [];
  const problems: InputProblem[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry === "string") {
      let value = deriveValue(entry);
      if (value === "") {
        value = `option_${index + 1}`;
      }
      if (taken.has(value)) {
        let n = 2;
        while (taken.has(`${value}_${n}`)) {
          n += 1;
        }
        value = `${value}_${n}`;
      }
      taken.add(value);
      derived.push(value);
      options.push({ value, label: entry });
      return;
    }
    if (!isInlineOption(entry)) {
      problems.push({ key: `${key}[${index}]`, expected: 'a string or { "value": "...", "label": "..." }' });
      return;
    }
    const prototype = prototypeKeyIn(entry, `${key}[${index}]`);
    if (prototype !== undefined) {
      throw prototypeRefusal(prototype);
    }
    const option: NormalisedOptions["options"][number] = { value: entry.value, label: entry.label ?? entry.value };
    if (entry.description !== undefined) {
      option.description = entry.description;
    }
    options.push(option);
  });
  if (problems.length > 0) {
    throw badInput(problems);
  }
  return { options, derived };
}

/** The `derived-option-values` warning for one component. */
export function derivedWarning(componentId: string, derived: readonly string[]): string {
  return `derived-option-values: ${componentId} option values were derived from their labels: ${derived.join(", ")}.`;
}

// ---- property paths ---------------------------------------------------------------------------

/** Names another tool owns, with the hint that names it. */
const RESERVED: Readonly<Record<string, string>> = {
  id: "Use rename_component to change an id.",
  type: "A component's type cannot change: remove it and add one of the other type with add_components.",
  children: "Use add_components, move_component or remove_components to change what a container holds.",
  rules: "Set one rule at a time as rules.<key> (rules.visibleWhen, rules.requiredWhen, ...).",
  collection: "A component's row binding is set when it is added (add_components collection)."
};

/** A parsed `propertyPath`. */
export interface ParsedPath {
  target: "configuration" | "rules";
  /** The configuration path, or the rule key. */
  path: string;
  segments: string[];
  /** `configuration-prefix` when the spelling carried one. */
  warnings: string[];
}

/**
 * Reads one edit's `propertyPath` and `target`: `rules.<key>` or
 * `target: "rules"` is a rule key from the `ComponentRules` set; a leading `configuration.` is
 * stripped with a warning; `id`, `type`, `children`, the whole `rules` and `collection` (and
 * any path under them) are refused naming the tool that owns them; prototype names and the length caps are `bad-input`.
 */
export function parsePropertyPath(raw: string, target: unknown, key: string): ParsedPath {
  const warnings: string[] = [];
  let path = raw.trim();
  if (target === "children") {
    throw badInput([{ key: `${key}.target`, expected: "'configuration' or 'rules' (children are changed with add_components, move_component and remove_components)" }]);
  }
  if (path === "") {
    throw badInput([{ key: `${key}.propertyPath`, expected: "a property path such as label or rules.visibleWhen" }]);
  }
  if (raw.length > PROPERTY_PATH_CHARS) {
    throw badInput([{ key: `${key}.propertyPath`, expected: `at most ${PROPERTY_PATH_CHARS} characters` }]);
  }
  let rule = target === "rules";
  if (path.startsWith("rules.")) {
    rule = true;
    path = path.slice("rules.".length);
  } else if (!rule && path.startsWith("configuration.")) {
    const stripped = path.slice("configuration.".length);
    warnings.push(`configuration-prefix: ${path} was read as ${stripped}.`);
    path = stripped;
  }
  const segments = path.split(".");
  if (segments.length > PROPERTY_PATH_SEGMENTS) {
    throw badInput([{ key: `${key}.propertyPath`, expected: `at most ${PROPERTY_PATH_SEGMENTS} segments` }]);
  }
  if (segments.some((segment) => segment === "")) {
    throw badInput([{ key: `${key}.propertyPath`, expected: "dot-separated names with nothing empty between the dots" }]);
  }
  const prototype = segments.find(isPrototypeName);
  if (prototype !== undefined) {
    throw prototypeRefusal(`${key}.propertyPath`);
  }
  if (rule) {
    if (segments.length !== 1 || !(RULE_KEYS as readonly string[]).includes(path)) {
      throw badInput([{ key: `${key}.propertyPath`, expected: `a rule key: ${RULE_KEYS.join(", ")}` }]);
    }
    return { target: "rules", path, segments, warnings };
  }
  const head = segments[0] as string;
  const reserved = RESERVED[head];
  // Any path under a reserved head (collection.collectionPath, id.x): the owning tool's hint,
  // never a configuration key that shadows the real one.
  if (reserved !== undefined) {
    throw new ToolRefusal("bad-input", `${head} cannot be set with set_properties.`, reserved, { problems: [{ key: `${key}.propertyPath`, expected: `not ${head}` }] });
  }
  return { target: "configuration", path, segments, warnings };
}

/** A rule key as the schemas spell it. */
export function isRuleKey(key: string): key is RuleKey {
  return (RULE_KEYS as readonly string[]).includes(key);
}

/** What the inspector says about a configuration path on one component. */
export interface PathKind {
  /** The inspector lists it (or its first segment), or the type's template has it. */
  known: boolean;
  /** The inspector's control for the exact path, when it lists one. */
  kind?: InspectorControl;
  /** Set when the path runs under a property whose control holds one plain value: that head's control. */
  scalarHead?: InspectorControl;
  /** With `scalarHead`: the path of that property, which can itself be dotted (`data.answersFree`). */
  scalarPath?: string;
}

/** Controls whose property holds one plain value, so nothing is written beneath it. */
const SCALAR_CONTROLS: ReadonlySet<InspectorControl> = new Set<InspectorControl>(["checkbox", "number", "text", "select", "localized-text"]);

/**
 * Whether the inspector offers `path` on `componentId` and as what (a property is
 * known when `inspectorModel(id)` lists it, or its first segment, in some section's fields, or
 * the type's template configuration has the first segment's key).
 */
export function pathKind(controller: BuilderController, componentId: string, type: string, segments: readonly string[]): PathKind {
  const path = segments.join(".");
  const head = segments[0] ?? "";
  let kind: InspectorControl | undefined;
  let known = false;
  let scalarHead: InspectorControl | undefined;
  let scalarPath: string | undefined;
  let model;
  try {
    model = controller.inspectorModel(componentId);
  } catch {
    model = undefined;
  }
  for (const section of model?.sections ?? []) {
    for (const field of section.fields) {
      if (field.propertyPath === path) {
        kind = field.control;
        known = true;
      } else if (field.propertyPath === head || field.propertyPath.startsWith(`${path}.`) || path.startsWith(`${field.propertyPath}.`)) {
        // A path under a field is known too (its own path may be dotted: data.answersFree).
        known = true;
        // A dotted path under a checkbox or number would replace the boolean or number with an object.
        if (path.startsWith(`${field.propertyPath}.`) && SCALAR_CONTROLS.has(field.control)) {
          scalarHead = field.control;
          scalarPath = field.propertyPath;
        }
      }
    }
  }
  if (!known) {
    const template = controller.componentTemplate(type);
    known = isRecord(template?.configuration) && Object.prototype.hasOwnProperty.call(template.configuration, head);
  }
  const found: PathKind = kind !== undefined ? { known, kind } : { known };
  if (scalarHead !== undefined) {
    found.scalarHead = scalarHead;
    found.scalarPath = scalarPath as string;
  }
  return found;
}

/** One value as its kind expects it: coerced (with a warning), normalised, or refused. */
export interface KindedValue {
  value: unknown;
  warnings: string[];
}

/**
 * Coerces a configuration value to the inspector's kind for it: a
 * checkbox's `"true"` / `"false"`, a number's numeral string (each with a `coerced` warning;
 * a value of the wrong shape for either kind is `bad-input`, as the inspector's Apply refuses it),
 * an option list (normalised, derived values reported), a translatable text (a string in the
 * form's default language). `null` clears the property and is never coerced.
 */
export function kindValue(value: unknown, kind: InspectorControl | undefined, where: { componentId: string; path: string; key: string }): KindedValue {
  const warnings: string[] = [];
  if (value === null || value === undefined) {
    return { value, warnings };
  }
  const name = `${where.componentId}.${where.path}`;
  if (kind === "checkbox") {
    if (typeof value === "boolean") {
      return { value, warnings };
    }
    // The runtime tests `=== true`, so any other shape would be stored and silently never enforced.
    const word = typeof value === "string" ? value.toLowerCase() : undefined;
    if (word !== "true" && word !== "false") {
      throw badInput([{ key: where.key, expected: 'true or false (the text "true" or "false" is read as a boolean; null clears it)' }]);
    }
    warnings.push(`coerced: ${name} "${value as string}" was written as ${word}.`);
    return { value: word === "true", warnings };
  }
  if (kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value, warnings };
    }
    const numeral = typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : undefined;
    if (numeral === undefined || !Number.isFinite(numeral)) {
      throw badInput([{ key: where.key, expected: "a finite number (a numeral text such as \"3\" is read as a number; null clears it)" }]);
    }
    warnings.push(`coerced: ${name} "${value as string}" was written as ${numeral}.`);
    return { value: numeral, warnings };
  }
  if (kind === "options" || (kind === undefined && where.path === "options")) {
    const normalised = normaliseOptions(value, where.key);
    if (normalised.derived.length > 0) {
      warnings.push(derivedWarning(where.componentId, normalised.derived));
    }
    return { value: normalised.options, warnings };
  }
  if (kind === "localized-text" && typeof value !== "string") {
    throw badInput([{ key: where.key, expected: "a string, in the form's default language (translations are written with the languages tool)" }]);
  }
  return { value, warnings };
}

/** The value at `path` in `target` (dot notation, numeric segments into lists), `undefined` when absent. */
export function readPath(target: unknown, path: string): unknown {
  let cursor: unknown = target;
  for (const part of path.split(".")) {
    if (Array.isArray(cursor) && /^\d+$/.test(part)) {
      cursor = cursor[Number(part)];
    } else if (isRecord(cursor)) {
      cursor = Object.prototype.hasOwnProperty.call(cursor, part) ? cursor[part] : undefined;
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Writes `value` at `path` the way the controller's `setProperties` does (BC `setNestedValue`):
 * objects are created on the way, a numeric segment steps into an existing list, and a list is
 * never created from a path.
 */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) {
    return;
  }
  const indexOf = (container: unknown, segment: string): number | undefined => (Array.isArray(container) && /^\d+$/.test(segment) ? Number(segment) : undefined);
  let cursor: Record<string, unknown> | unknown[] = target;
  for (const part of parts) {
    const index = indexOf(cursor, part);
    const current = index !== undefined ? (cursor as unknown[])[index] : (cursor as Record<string, unknown>)[part];
    if (!isRecord(current) && !Array.isArray(current)) {
      if (index !== undefined) {
        (cursor as unknown[])[index] = {};
      } else {
        (cursor as Record<string, unknown>)[part] = {};
      }
    }
    cursor = (index !== undefined ? (cursor as unknown[])[index] : (cursor as Record<string, unknown>)[part]) as Record<string, unknown> | unknown[];
  }
  const index = indexOf(cursor, last);
  if (index !== undefined) {
    (cursor as unknown[])[index] = value;
  } else {
    (cursor as Record<string, unknown>)[last] = value;
  }
}

/** Whether two values serialise alike (a no-op edit). */
export function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/** A copy of `node` safe to change in memory (the controller shares configuration objects with the tree). */
export function cloneNode(node: ComponentNode): ComponentNode {
  return structuredClone(node);
}
