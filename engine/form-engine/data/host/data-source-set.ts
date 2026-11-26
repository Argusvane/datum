import type {
  DataSourceContext,
  DataSourceProvider,
  DataSourceRequest,
  DataSourceResult,
  DataSourceSet
} from "../../core/schema/contracts.js";

export type DataSourceItems = DataSourceResult["items"];

/**
 * A data source written as a function: given the request (its id and query) and the context
 * (locale, the form's current values, the environment), returns the items — as a bare array
 * or a full {@link DataSourceResult}, now or later.
 */
export type DataSourceLoader = (
  request: DataSourceRequest,
  context: DataSourceContext
) => DataSourceResult | DataSourceItems | Promise<DataSourceResult | DataSourceItems>;

/**
 * What a host may define a data source as: a fixed list of items, a loader function, or a
 * full {@link DataSourceProvider} (a `StaticDataSourceProvider`, a `RemoteDataSourceProvider`,
 * one of its own).
 */
export type DataSourceInput = DataSourceItems | DataSourceLoader | DataSourceProvider;

/** Data sources keyed by the id a component names in `configuration.data.sourceId`. */
export type DataSourceInputs = Record<string, DataSourceInput>;

export interface DefineDataSourcesOptions {
  /**
   * The environment the set resolves in, handed to every loader and checked against a
   * provider's declared `environments`. Defaults to `"client"`, which is where a set handed
   * to a renderer or builder runs; a server host defining the same sources says `"server"`.
   */
  environment?: DataSourceContext["environment"];
}

function isProvider(input: DataSourceInput): input is DataSourceProvider {
  return !Array.isArray(input) && typeof input === "object" && typeof input.load === "function";
}

function toResult(value: DataSourceResult | DataSourceItems): DataSourceResult {
  return Array.isArray(value) ? { items: value } : value;
}

/**
 * Defines the data sources a host wires alongside a form — the shortest route from "I have
 * a list of countries" to a `select` that offers them:
 *
 * ```ts
 * const dataSources = defineDataSources({
 *   countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }],
 *   cities: async ({ query }, { values }) => fetchCities(values.country, query),
 *   products: new RemoteDataSourceProvider("products", "https://api.example.com/options")
 * });
 * host.dataSources = dataSources;                 // the renderer resolves `data.sourceId` against it
 * builder.dataSources = dataSources;              // the canvas previews it; the picker lists its ids
 * new FormRuntime(form, { dataSources, ... });    // optional: the runtime (and validation) see it too
 * ```
 *
 * The result is a {@link DataSourceSet}: a `DataSourceRuntime` (so it can also be handed to
 * `FormRuntime`) that knows its ids. A renderer consults it first and falls back to the
 * runtime's registered sources for any id it does not hold, so a host can mix the two —
 * shared, registered sources for the enterprise lookups and a set defined at wiring time for
 * the page's own.
 */
export function defineDataSources(
  sources: DataSourceInputs,
  options: DefineDataSourcesOptions = {}
): DataSourceSet {
  const environment = options.environment ?? "client";
  const loaders = new Map<string, (request: DataSourceRequest, context: DataSourceContext) => Promise<DataSourceResult>>();

  for (const [id, input] of Object.entries(sources)) {
    if (Array.isArray(input)) {
      // A fixed list: copied on every load, so a caller mutating what it got never edits the
      // definition (the same care `StaticDataSourceProvider` takes).
      loaders.set(id, async () => ({ items: input.map((item) => ({ ...item })) }));
    } else if (isProvider(input)) {
      loaders.set(id, async (request, context) => {
        if (input.environments && !input.environments.includes(context.environment)) {
          throw new Error(
            `Data source "${id}" is not available in the ${context.environment} environment`
          );
        }
        return input.load(request, context);
      });
    } else if (typeof input === "function") {
      loaders.set(id, async (request, context) => toResult(await input(request, context)));
    } else {
      throw new Error(
        `Data source "${id}" must be an array of items, a loader function, or a data source provider`
      );
    }
  }

  return {
    has: (sourceId) => loaders.has(sourceId),
    ids: () => [...loaders.keys()],
    async load(sourceId, query = {}, context = {}) {
      const loader = loaders.get(sourceId);
      if (!loader) {
        throw new Error(`No data source defined for id: ${sourceId}`);
      }
      return loader({ sourceId, query }, { ...context, environment });
    }
  };
}
