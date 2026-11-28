import type { DataSourceResult, ResolvedDataSourceItem, TranslationCatalog } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { readInlineOptions, resolveInlineOptionItems } from "../../core/schema/inline-options.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { resolveLocalizedText } from "../../core/localization/localized-text.js";
import { workedOutTextOwner } from "../../core/journey/worked-out-text.js";
import type { FormTranslations } from "../../core/localization/translations.js";

/**
 * The most items one data source may offer a component. A longer answer is cut to
 * this many, a warning is logged, and the field says so; a list this long is a search box's job,
 * not a select's. The browser draws every item it is given, so the cap is the engine's own.
 */
export const MAX_DATA_SOURCE_ITEMS = 5000;

/**
 * What a build answers for a source it has no answer for yet when it must not wait (the first
 * paint with `data-source-wait="none"`): the field is drawn in the `loading` state until the
 * real build lands and repaints.
 */
export class DataSourcePending extends Error {
  constructor() {
    super("The data source has not answered yet");
    this.name = "DataSourcePending";
  }
}

export interface DataSourceResolver {
  resolveDataSource(request: {
    componentId: string;
    sourcePropertyPath?: string | undefined;
    query?: Record<string, unknown> | undefined;
    /** The locale to load in, when a render asks for another than the runtime's current one. */
    locale?: string | undefined;
  }): Promise<DataSourceResult | undefined>;
}

export interface ComponentOptionState {
  componentId: string;
  /** `loading`: the source is configured and has not answered yet (a paint that did not wait for it). */
  status: "not-applicable" | "loading" | "ready" | "error";
  items: ResolvedDataSourceItem[];
  error?: string;
  /** The id of the data source the component names, when it names one (the id a `datum-error` carries). */
  sourceId?: string;
  /** Set when the answer held more than {@link MAX_DATA_SOURCE_ITEMS}: the items were cut to the cap, `total` is what came. */
  truncated?: { total: number };
  /** Set when the source answered, but not a list of `{ value, label }` text items (the host is told, see the renderer). */
  malformed?: true;
}

/**
 * What resolving a component's *inline* options needs: the locale its labels are read in, the
 * definition's own translations and the host's catalog.
 */
export interface InlineOptionContext {
  locale: string;
  translations?: FormTranslations | undefined;
  translationCatalog?: TranslationCatalog | undefined;
}

const DEFAULT_INLINE_CONTEXT: InlineOptionContext = { locale: "en" };

function hasChildren(node: ComponentNode): boolean {
  return Boolean(node.children && Object.keys(node.children).length > 0);
}

function walk(node: ComponentNode, out: ComponentNode[]): void {
  out.push(node);
  if (!hasChildren(node) || !node.children) {
    return;
  }

  for (const group of Object.values(node.children)) {
    for (const child of group) {
      walk(child, out);
    }
  }
}

// A data source is host data: its texts are a string or a host's `LocalizedText`.
const isText = (text: unknown): boolean =>
  typeof text === "string" ||
  (typeof text === "object" && text !== null && !Array.isArray(text) && typeof (text as { default?: unknown }).default === "string");

const isSourceItem = (item: unknown): item is DataSourceResult["items"][number] =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as { value?: unknown }).value === "string" &&
  isText((item as { label?: unknown }).label) &&
  ((item as { description?: unknown }).description === undefined || isText((item as { description?: unknown }).description));

/**
 * A source's items with their texts read in the filler's locale: a plain string
 * is shown as given, a localized label is resolved for the locale from its own words (host data
 * has no address in the form's map, so neither map nor catalog applies). Everything downstream
 * (markup, answers, review, PDF) gets strings.
 */
function resolveSourceItems(items: DataSourceResult["items"], locale: string): ResolvedDataSourceItem[] {
  return items.map(({ label, description: rawDescription, ...rest }) => {
    const description = rawDescription !== undefined ? resolveLocalizedText(rawDescription, locale) : undefined;
    return {
      ...rest,
      label: resolveLocalizedText(label, locale) ?? rest.value,
      ...(description ? { description } : {})
    };
  });
}

/**
 * A component's option list, from whichever route feeds it. The data source is asked first:
 * a component naming one (`data.sourceId`) takes its items from the resolver, and the resolver
 * answers `undefined` for a component that names none — which is when the component's own
 * inline `options` apply. A configured source that fails stays an error rather than falling
 * back to the inline list, so a broken integration is visible instead of silently showing
 * whatever the author typed months earlier.
 */
export async function resolveComponentOptionState(
  resolver: DataSourceResolver,
  component: ComponentNode,
  query?: Record<string, unknown>,
  sourcePropertyPath?: string,
  inline: InlineOptionContext = DEFAULT_INLINE_CONTEXT
): Promise<ComponentOptionState> {
  // The source this component names, if any. A configured source never falls back to the
  // inline list, whether it fails, times out or answers nothing: the field offers no options and
  // says why. Inline options stand only for a component naming no source.
  const sourceId = readSourceId(component.configuration, sourcePropertyPath);
  const named = sourceId === undefined ? {} : { sourceId };
  try {
    let result: DataSourceResult | undefined;
    try {
      result = await resolver.resolveDataSource({
        componentId: component.id,
        sourcePropertyPath,
        query
      });
    } catch (error) {
      if (!(error instanceof DataSourcePending)) {
        throw error;
      }
      if (sourceId !== undefined) {
        return { componentId: component.id, status: "loading", items: [], ...named };
      }
      result = undefined;
    }

    // `undefined` is the resolver saying no source applies here (a component naming none, or a
    // presentation's own field): the inline options stand. A source that *ran* and
    // answered nothing never reaches this point as `undefined`: the loaders that call it
    // (host-data-sources.ts, FormRuntime.resolveDataSource) turn that into an error.
    if (!result) {
      const options = readInlineOptions(component.configuration);
      if (options.length > 0) {
        return {
          componentId: component.id,
          status: "ready",
          items: resolveInlineOptionItems(options, workedOutTextOwner(component, "options"), inline.locale, {
            translations: inline.translations,
            catalog: inline.translationCatalog
          })
        };
      }
      return {
        componentId: component.id,
        status: "not-applicable",
        items: []
      };
    }

    const items = result.items;
    if (!Array.isArray(items) || !items.every(isSourceItem)) {
      // A remote endpoint's JSON is untyped input: an answer that is not a list of
      // { value, label } strings is no answer, and says so rather than breaking the paint.
      const message = `The data source for "${component.id}" did not answer a list of { value, label } text items`;
      console.warn(`[datum] ${message}; treated as an empty answer`);
      return { componentId: component.id, status: "error", items: [], error: message, malformed: true, ...named };
    }
    if (items.length > MAX_DATA_SOURCE_ITEMS) {
      console.warn(
        `[datum] The data source for "${component.id}" answered ${items.length} items; only the first ${MAX_DATA_SOURCE_ITEMS} are offered`
      );
      return {
        componentId: component.id,
        status: "ready",
        items: resolveSourceItems(items.slice(0, MAX_DATA_SOURCE_ITEMS), inline.locale),
        truncated: { total: items.length },
        ...named
      };
    }
    return {
      componentId: component.id,
      status: "ready",
      items: resolveSourceItems(items, inline.locale),
      ...named
    };
  } catch (error) {
    return {
      componentId: component.id,
      status: "error",
      items: [],
      error: error instanceof Error ? error.message : String(error),
      ...named
    };
  }
}

export async function resolveOptionStatesForTree(
  resolver: DataSourceResolver,
  root: ComponentNode,
  queryByComponentId: Record<string, Record<string, unknown>> = {},
  sourcePathByComponentId: Record<string, string> = {},
  inline: InlineOptionContext = DEFAULT_INLINE_CONTEXT
): Promise<Record<string, ComponentOptionState>> {
  const nodes: ComponentNode[] = [];
  walk(root, nodes);

  // Own keys only: a component named `constructor` or `__proto__` has no query or source path of its
  // own, and must not read Object.prototype's.
  const own = <T>(record: Record<string, T>, id: string): T | undefined =>
    Object.prototype.hasOwnProperty.call(record, id) ? record[id] : undefined;
  const states = await Promise.all(
    nodes.map((node) =>
      resolveComponentOptionState(resolver, node, own(queryByComponentId, node.id), own(sourcePathByComponentId, node.id), inline)
    )
  );

  return Object.fromEntries(states.map((state) => [state.componentId, state]));
}
