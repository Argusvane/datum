import type { CapabilityDefinition, ResolvedDataSourceItem, PropertyEditorContribution } from "./contracts.js";
import type { ComponentNode } from "./types.js";
import { addressOf, resolveText, type TextSources } from "../localization/translations.js";

/**
 * Inline options: the choices a `select`, `radio` or `checkboxes` component carries in its own
 * configuration, for the common case where the list is short, fixed, and the author's to
 * write — "Yes / No", a handful of categories. They live under `configuration.options` as
 * `{ value, label }` pairs, the same shape a data source's items take, so the two routes meet
 * in one `optionState` and the markup never knows which one fed it.
 *
 * A data source (`configuration.data.sourceId`) is the other route, for lists that are long,
 * shared, or live elsewhere. When a component names one, the data source wins and the inline
 * list is ignored — see `resolveComponentOptionState`.
 */

export const INLINE_OPTIONS_PROPERTY = "options";

/**
 * What the builder takes from a file or a paste for one options list:
 * 2,000 options (the server's per-list structure cap, `kernelStructureLimits().optionsPerComponent`:
 * more is `option.tooMany` at the next Save) and 2 MiB of text. Past either, the editor would paint
 * one row of inputs per option.
 */
export const MAX_IMPORTED_OPTIONS = 2000;
export const MAX_IMPORTED_OPTIONS_BYTES = 2 * 1024 * 1024;

export interface InlineOption {
  /** What the field stores when this option is picked. Unique within the list. */
  value: string;
  /**
   * What the person filling the form reads, in the form's default language. Its translations
   * live in the definition's map under the option's value (`addressOf.option`), so
   * reordering the list never moves a translation onto another option.
   */
  label: string;
  /**
   * A line of help under the option's label — what picking it means, when the label alone
   * is not enough ("Personal — for you or your family"). Translated like the label. The
   * markup draws it as the option's hint (`datum-form__option-hint`, the input's
   * `aria-describedby`), a PDF checklist as a second line; a `<select>` has nowhere to put
   * one, so a select's options show their labels alone.
   */
  description?: string;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Whether `value` is a usable option entry: a string `value`, and a string `label` and `description` if any. */
export function isInlineOption(value: unknown): value is InlineOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as { value?: unknown; label?: unknown; description?: unknown };
  if (typeof record.value !== "string") {
    return false;
  }
  return isOptionalText(record.label) && isOptionalText(record.description);
}

/**
 * An option list as authored (or imported), in order. Tolerant of what it finds: an entry
 * that is not an option (a stray string, an object without a `value`) is skipped rather than
 * failing the whole list, and an option without a label is shown by its value.
 */
export function parseInlineOptions(value: unknown): InlineOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: InlineOption[] = [];
  for (const entry of value) {
    if (!isInlineOption(entry)) {
      continue;
    }
    // An empty description is no description: the hint slot stays out of the markup.
    const description = entry.description === "" ? undefined : entry.description;
    out.push({
      value: entry.value,
      label: entry.label ?? entry.value,
      ...(description !== undefined ? { description } : {})
    });
  }
  return out;
}

/** The inline options a configuration declares under `options`. */
export function readInlineOptions(configuration: unknown): InlineOption[] {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return [];
  }
  return parseInlineOptions((configuration as Record<string, unknown>)[INLINE_OPTIONS_PROPERTY]);
}

/**
 * Inline options as the items a data source would have returned, their texts resolved for
 * `locale` through the definition's map and the host's catalog at the owning component's
 * option addresses (`ownerId` is that component's id).
 */
export function resolveInlineOptionItems(
  options: readonly InlineOption[],
  ownerId: string,
  locale: string,
  sources: TextSources
): ResolvedDataSourceItem[] {
  return options.map((option) => {
    const description =
      option.description !== undefined
        ? resolveText(option.description, addressOf.option(ownerId, option.value, "description"), locale, sources)
        : undefined;
    return {
      value: option.value,
      label: resolveText(option.label, addressOf.option(ownerId, option.value, "label"), locale, sources),
      ...(description ? { description } : {})
    };
  });
}

export interface InlineOptionsCapabilityOptions {
  id?: string;
  version?: string;
  /** Where the list lives in the configuration. Defaults to `options`. */
  propertyPath?: string;
}

/**
 * The capability a component type declares to author inline options in the builder: it
 * contributes an `options-editor` field, which the properties panel renders as a summary row
 * with an "Edit options…" button opening the options editor. Pair it with
 * `createDataSourceCapability()` on a type that can also take a data source.
 */
export function createInlineOptionsCapability(
  options: InlineOptionsCapabilityOptions = {}
): CapabilityDefinition {
  const propertyPath = options.propertyPath ?? INLINE_OPTIONS_PROPERTY;
  return {
    id: options.id ?? "inlineOptions",
    version: options.version ?? "1.0.0",
    apply(component: ComponentNode): ComponentNode {
      if (!component.configuration || typeof component.configuration !== "object") {
        component.configuration = {};
      }
      return component;
    },
    configureEditor: (): PropertyEditorContribution => ({
      fields: [
        {
          id: "options",
          type: "options-editor",
          propertyPath,
          label: "Options",
          description: "The choices this field offers. A data source, when one is set, takes precedence."
        }
      ]
    })
  };
}
