import { RegisteredDataSourceRuntime } from "../providers/registered-data-source-runtime.js";
import { DataSourceProviderRegistry } from "../providers/data-source-provider-registry.js";
import { DataSourceRegistry } from "../../registry/data-sources/data-source-registry.js";

export class RegisteredClientDataSourceRuntime extends RegisteredDataSourceRuntime {
  constructor(definitions: DataSourceRegistry, providers: DataSourceProviderRegistry) {
    super(definitions, providers, "client");
  }
}
