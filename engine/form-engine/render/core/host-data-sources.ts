import type { DataSourceResult, DataSourceSet } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { ComponentTree } from "../../core/tree/component-tree.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import type { DataSourceResolver } from "./component-options.js";
import type { RenderableRuntime } from "./runtime-render-bridge.js";

export interface DataSourceSetLookup {
  /** The component the request is for, from whatever tree the caller renders. */
  node: ComponentNode | undefined;
  request: Parameters<DataSourceResolver["resolveDataSource"]>[0];
  locale: string;
  values: Record<string, unknown>;
}

/**
 * Resolves a request through a host-defined {@link DataSourceSet}, or reports that the set
 * does not hold the source the component names (`undefined`) so the caller can fall back to
 * whatever else it has — a `FormRuntime`'s registered sources, a builder's host resolver.
 * The locale and values go along as the context, the same way `FormRuntime.resolveDataSource`
 * hands them to registered providers, so a loader can filter on what the form already holds.
 * A caller hands the form's values alone (`FormRuntime.formValues`): a loader may send its
 * context on, and a presentation's own answers never leave the browser.
 */
export function resolveThroughDataSourceSet(
  dataSources: DataSourceSet | undefined,
  lookup: DataSourceSetLookup
): Promise<DataSourceResult> | undefined {
  if (!dataSources) {
    return undefined;
  }
  const sourceId = readSourceId(lookup.node?.configuration, lookup.request.sourcePropertyPath);
  if (!sourceId || !dataSources.has(sourceId)) {
    return undefined;
  }
  return Promise.resolve(
    dataSources.load(sourceId, lookup.request.query, {
      locale: lookup.locale,
      values: { ...lookup.values }
    })
  ).then((result) => {
      // A source that ran and answered nothing has failed; `undefined` would read as "no
      // source here" and bring the author's inline list back.
      if (result === undefined || result === null) {
        throw new Error(`The data source "${sourceId}" answered nothing`);
      }
      return result;
    });
}

/**
 * The resolver a renderer builds over a runtime: the host's wiring-time data sources first,
 * then the runtime's own `resolveDataSource` for everything else — which is where a
 * component naming no source at all is answered with `undefined` (and its inline options,
 * if any, take over). With no set, this is the runtime's resolver and nothing more. `tree`
 * finds the component a request is for; the values handed on are the runtime's form values
 * when it has them, else its state's. `locale` is the one a render for another language than
 * the runtime's draws in (a printed copy in French): both the host's sources and the runtime's
 * are asked in it, so their answers are worded as the rest of the render is.
 */
export function createHostDataSourceResolver(
  runtime: RenderableRuntime,
  dataSources: DataSourceSet | undefined,
  tree: () => Pick<ComponentTree, "find"> = () => runtime.componentTree(),
  locale?: string
): DataSourceResolver {
  return {
    resolveDataSource: (request) => {
      const state = runtime.state();
      const asked = request.locale ?? locale;
      return (
        resolveThroughDataSourceSet(dataSources, {
          node: tree().find(request.componentId),
          request,
          locale: asked ?? state.locale,
          values: dataSources ? (runtime.formValues?.() ?? state.values) : state.values
        }) ?? runtime.resolveDataSource(asked !== undefined ? { ...request, locale: asked } : request)
      );
    }
  };
}

/** How long a data source may take before it counts as failed, when the host sets nothing. */
export const DEFAULT_DATA_SOURCE_TIMEOUT_MS = 15000;

/**
 * `promise`, or a rejection once `ms` have passed (`0` or less: no limit). The timer is cleared
 * as soon as the promise settles, so a fast source leaves nothing pending.
 */
export function withDataSourceTimeout<T>(promise: Promise<T>, ms: number, sourceId: string): Promise<T> {
  if (!(ms > 0)) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The data source "${sourceId}" did not answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * A {@link DataSourceSet} whose loads end after `ms` milliseconds with an error naming the
 * source, so a source that never answers is a failed source (shown on its field, reported as a
 * `datum-error`) and not a form that never finishes. The set it wraps is untouched.
 */
export function timedDataSourceSet(set: DataSourceSet, ms: number): DataSourceSet {
  if (!(ms > 0)) {
    return set;
  }
  return {
    has: (sourceId) => set.has(sourceId),
    ids: () => set.ids(),
    load: (sourceId, query, context) => {
      let pending: Promise<DataSourceResult>;
      try {
        pending = Promise.resolve(set.load(sourceId, query, context));
      } catch (error) {
        return Promise.reject(error);
      }
      return withDataSourceTimeout(pending, ms, sourceId);
    }
  };
}
