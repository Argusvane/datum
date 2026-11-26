import type {
  DataSourceRuntime,
  DataSourceContext,
  DataSourceRequest,
  DataSourceResult
} from "../../core/schema/contracts.js";
import type { DataSourceDefinition } from "../../registry/data-sources/data-source-registry.js";
import { DataSourceRegistry } from "../../registry/data-sources/data-source-registry.js";
import { DataSourceProviderRegistry } from "./data-source-provider-registry.js";

export class RegisteredDataSourceRuntime implements DataSourceRuntime {
  constructor(
    private readonly definitions: DataSourceRegistry,
    private readonly providers: DataSourceProviderRegistry,
    private readonly environment: DataSourceContext["environment"]
  ) {}

  public async load(
    sourceId: string,
    query: DataSourceRequest["query"] = {},
    context: Omit<DataSourceContext, "environment"> = {},
    version?: string
  ): Promise<DataSourceResult> {
    const definition: DataSourceDefinition = this.definitions.resolve(sourceId, version);
    const provider = this.providers.resolve(definition.providerId, this.environment);

    return provider.load(
      {
        sourceId,
        query: {
          ...(definition.defaultQuery ?? {}),
          ...(query ?? {})
        }
      },
      {
        ...context,
        environment: this.environment
      }
    );
  }
}
