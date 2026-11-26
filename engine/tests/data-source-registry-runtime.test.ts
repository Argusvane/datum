import { describe, expect, it } from "vitest";

import { RegisteredClientDataSourceRuntime } from "../form-engine/data/client/registered-client-data-source-runtime.js";
import { RegisteredServerDataSourceRuntime } from "../form-engine/data/server/registered-server-data-source-runtime.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { StaticDataSourceProvider } from "../form-engine/data/providers/static-data-source-provider.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";

describe("data source registry runtime", () => {
  it("resolves latest source definition and merges default query", async () => {
    const defs = new DataSourceRegistry();
    defs.register({
      id: "countries",
      providerId: "static-countries",
      version: "1.0.0",
      defaultQuery: { region: "americas" }
    });

    const providers = new DataSourceProviderRegistry();
    providers.register(
      new StaticDataSourceProvider("static-countries", [
        { value: "CA", label: "Canada", meta: { region: "americas" } }
      ])
    );

    const runtime = new RegisteredClientDataSourceRuntime(defs, providers);
    const result = await runtime.load("countries", { localeHint: "en" }, { locale: "en-CA" });

    expect(result.items[0]?.value).toBe("CA");
  });

  it("uses server environment in registered server runtime", async () => {
    const defs = new DataSourceRegistry();
    defs.register({ id: "countries", providerId: "provider", version: "1.0.0" });

    const providers = new DataSourceProviderRegistry();
    const seen: string[] = [];
    providers.register({
      id: "provider",
      load: async (_request, context) => {
        seen.push(context.environment);
        return { items: [] };
      }
    });

    const runtime = new RegisteredServerDataSourceRuntime(defs, providers);
    await runtime.load("countries");

    expect(seen).toEqual(["server"]);
  });

  it("throws when source definition is missing", async () => {
    const defs = new DataSourceRegistry();
    const providers = new DataSourceProviderRegistry();
    const runtime = new RegisteredClientDataSourceRuntime(defs, providers);

    await expect(runtime.load("missing")).rejects.toThrow(/No data source registered/);
  });
});
