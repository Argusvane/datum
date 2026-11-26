import type {
  DataSourceContext,
  DataSourceRequest,
  DataSourceResult
} from "../../core/schema/contracts.js";
import { DataSourceProviderRegistry } from "../providers/data-source-provider-registry.js";

export class ServerDataSourceRuntime {
  constructor(private readonly registry: DataSourceProviderRegistry) {}

  public async load(
    providerId: string,
    request: DataSourceRequest,
    context: Omit<DataSourceContext, "environment"> = {}
  ): Promise<DataSourceResult> {
    const provider = this.registry.resolve(providerId, "server");
    return provider.load(request, {
      ...context,
      environment: "server"
    });
  }
}
