import type { DataSourceContext, DataSourceProvider } from "../../core/schema/contracts.js";

export class DataSourceProviderRegistry {
  private readonly providers = new Map<string, DataSourceProvider>();

  public register(provider: DataSourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Data source provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Resolves a provider by id. When `environment` is supplied, a provider whose declared
   * `environments` list excludes it is rejected — client and server runtimes pass their
   * own environment so a server-only provider cannot be reached from the browser.
   */
  public resolve(
    providerId: string,
    environment?: DataSourceContext["environment"]
  ): DataSourceProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Data source provider not found: ${providerId}`);
    }
    if (
      environment &&
      provider.environments &&
      !provider.environments.includes(environment)
    ) {
      throw new Error(
        `No data source provider "${providerId}" is available in the ${environment} environment`
      );
    }
    return provider;
  }
}
