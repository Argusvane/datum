import type { LiveBinding } from "../../render/live/contract.js";
import { isValidComponentClassToken } from "../../core/schema/component-classes.js";
import { PANEL_LOOK_CLASSES } from "../../render/live/look-classes.js";
import { BuilderWords } from "../logic/builder-texts.js";

/**
 * What the binding the canvas draws with makes available to `configuration.cssClass`: the classes it declares (`LiveBinding.cssClasses`), the author-facing names its
 * design system gives a meaning to (a width variant, a label size, a callout, a panel's look). An
 * entry is a bare name or a declaration with a label, a description, the component types it
 * applies to and a group of classes that exclude each other; it is normalised once here. The
 * inspector's Style tab offers the ones that apply to the selected component, and the class check
 * notes a class outside the names, which keeps a form portable across the bindings a host offers
 * instead of quietly depending on page CSS that only exists in one deployment. A binding that
 * declares none declares no vocabulary.
 */

/** One class a binding declares, normalised: its name and what the Style tab needs to offer it. */
export interface CssClassChoice {
  name: string;
  /** What the Style tab calls it: the declared label, else the name. */
  label: string;
  description?: string | undefined;
  /** The component types it applies to; absent for any component. An empty list is no component. */
  types?: readonly string[] | undefined;
  /** The set it excludes the others of; absent for a class that stands alone. */
  group?: string | undefined;
  /** What the Style tab calls the group when it is not one the builder words itself; absent: "Choose one". */
  groupLabel?: string | undefined;
}

/** The component a Style tab is for: its type as written and the type it reads as. */
export interface CssClassSubject {
  type: string;
  base?: string | undefined;
}

const declared = new WeakMap<object, CssClassChoice[]>();

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The classes `binding` declares, normalised once: a bare name or a declaration object become the
 * same shape, the malformed dropped, in the binding's order. A name declared twice is one class: a
 * later declaration object replaces the earlier entry in its place (as `mergeCssClasses` does), and
 * a later bare name never downgrades a declaration. `[]` for a binding that declares none.
 */
export function bindingClassDeclarations(binding: Pick<LiveBinding, "cssClasses"> | undefined): readonly CssClassChoice[] {
  const entries = binding?.cssClasses;
  if (!Array.isArray(entries)) {
    return [];
  }
  const cached = declared.get(entries);
  if (cached !== undefined) {
    return cached;
  }
  const out: CssClassChoice[] = [];
  const put = (choice: CssClassChoice): void => {
    const at = out.findIndex((existing) => existing.name === choice.name);
    if (at >= 0) {
      out[at] = choice;
    } else {
      out.push(choice);
    }
  };
  for (const entry of entries as readonly unknown[]) {
    const isObject = typeof entry === "object" && entry !== null && !Array.isArray(entry);
    const name = textOf(isObject ? (entry as { name?: unknown }).name : entry);
    if (name === undefined || !isValidComponentClassToken(name)) {
      continue;
    }
    if (!isObject) {
      if (!out.some((existing) => existing.name === name)) {
        out.push({ name, label: name });
      }
      continue;
    }
    const source = entry as { label?: unknown; description?: unknown; types?: unknown; group?: unknown; groupLabel?: unknown };
    // A list that names no type (empty, or only blanks) is no component, not any: only an absent one is any.
    const types = Array.isArray(source.types) ? source.types.map(textOf).filter((type): type is string => type !== undefined) : undefined;
    const description = textOf(source.description);
    const group = textOf(source.group);
    const groupLabel = textOf(source.groupLabel);
    put({
      name,
      label: textOf(source.label) ?? name,
      ...(description !== undefined ? { description } : {}),
      ...(types !== undefined ? { types } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(groupLabel !== undefined && group !== undefined ? { groupLabel } : {})
    });
  }
  declared.set(entries, out);
  return out;
}

/** The class names `binding` declares, well-formed and de-duplicated, in its order; `[]` for none. */
export function bindingClassNames(binding: Pick<LiveBinding, "cssClasses"> | undefined): string[] {
  return bindingClassDeclarations(binding).map((choice) => choice.name);
}

/**
 * The vocabulary the class check holds a `cssClass` against: the names `binding` declares and the
 * shared panel looks, which every binding accepts, but only when the binding declares at least one
 * class beyond those looks. A binding that declares only the looks (the GC Design System's, Datum's
 * own) declares no vocabulary, so a class a page's CSS gives a meaning to is not a mistake there;
 * one with classes of its own (Québec's `qc-size-*`) keeps them as the vocabulary, the looks
 * accepted in addition. `[]` for no vocabulary.
 */
export function bindingClassVocabulary(binding: Pick<LiveBinding, "cssClasses"> | undefined): string[] {
  const names = bindingClassNames(binding);
  const looks = PANEL_LOOK_CLASSES.map((look) => look.name);
  return names.some((name) => !looks.includes(name)) ? [...names, ...looks.filter((look) => !names.includes(look))] : [];
}

/** Whether `choice` applies to a component: it names no type, or the component's type or the type it reads as. */
function appliesTo(choice: CssClassChoice, subject: CssClassSubject | undefined): boolean {
  if (choice.types === undefined) {
    return true;
  }
  return subject !== undefined && (choice.types.includes(subject.type) || (subject.base !== undefined && choice.types.includes(subject.base)));
}

/**
 * The Style tab's choices for `binding` on one component: each class that applies to its type, in
 * the binding's order, with its label and description. Without a subject only the classes that
 * name no type are offered.
 */
export function bindingClassChoices(binding: Pick<LiveBinding, "cssClasses"> | undefined, subject?: CssClassSubject): CssClassChoice[] {
  return bindingClassDeclarations(binding).filter((choice) => appliesTo(choice, subject));
}

/** The class tokens in a `cssClass` value (string or list), in order and once each. */
export function cssClassTokens(value: unknown): string[] {
  const parts = typeof value === "string" ? value.split(/\s+/) : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const out: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (token !== "" && !out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

/**
 * A `cssClass` value with `name` ticked or cleared, as the new value (`undefined` when no class is left). Ticking a
 * class that sits in a group takes every other class of that group away in the same edit, so one
 * write leaves the component with at most one of them; clearing only removes the class.
 */
export function toggleCssClass(value: unknown, name: string, on: boolean, choices: readonly CssClassChoice[]): string | undefined {
  const group = choices.find((choice) => choice.name === name)?.group;
  const rivals = new Set(group === undefined ? [] : choices.filter((choice) => choice.group === group).map((choice) => choice.name));
  const tokens = cssClassTokens(value).filter((token) => token !== name && !(on && rivals.has(token)));
  if (on) {
    tokens.push(name);
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

/** A `cssClass` value with every class of `group` taken away: the way back to the binding's default look. */
export function clearCssClassGroup(value: unknown, group: string, choices: readonly CssClassChoice[]): string | undefined {
  const members = new Set(choices.filter((choice) => choice.group === group).map((choice) => choice.name));
  const tokens = cssClassTokens(value).filter((token) => !members.has(token));
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function quoteList(tokens: readonly string[], words: BuilderWords): string {
  return tokens.map((token) => `"${token}"`).join(words.text("themeClasses.sep"));
}

/** What checking a `cssClass` value found, split by severity. */
export interface CssClassCheckResult {
  /**
   * A token that is not a class name at all. The renderer silently drops these
   * (see `readComponentClassNames`), so authoring one is always a mistake — Save refuses it.
   */
  error: string | undefined;
  /**
   * A well-formed class the binding does not declare. Advisory only: the class may mean nothing
   * under this binding, but page CSS or another binding may give it meaning, so it is worth
   * saying without standing in the way of a save.
   */
  warning: string | undefined;
}

/**
 * Checks a `cssClass` value (string or list, as the schema accepts) against the binding's class
 * vocabulary ({@link bindingClassNames}). With an empty `classNames` the vocabulary check is
 * skipped entirely: a binding that declares no classes declares no vocabulary to be outside of.
 */
export function validateComponentCssClasses(
  value: unknown,
  classNames: readonly string[],
  words: BuilderWords = new BuilderWords()
): CssClassCheckResult {
  const parts =
    typeof value === "string"
      ? value.split(/\s+/)
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
  const tokens = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return { error: undefined, warning: undefined };
  }

  const malformed = tokens.filter((token) => !isValidComponentClassToken(token));
  const error = malformed.length > 0 ? words.plural("themeClasses.invalid", malformed.length, { list: quoteList(malformed, words) }) : undefined;

  let warning: string | undefined;
  if (classNames.length > 0) {
    const known = new Set(classNames);
    const unknown = tokens.filter((token) => isValidComponentClassToken(token) && !known.has(token));
    if (unknown.length > 0) {
      warning = words.plural("themeClasses.unknown", unknown.length, { list: quoteList(unknown, words) });
    }
  }
  return { error, warning };
}
