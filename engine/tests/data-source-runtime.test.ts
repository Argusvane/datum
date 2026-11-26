import { describe, expect, it } from "vitest";

import { ClientDataSourceRuntime } from "../form-engine/data/client/client-data-source-runtime.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { ServerDataSourceRuntime } from "../form-engine/data/server/server-data-source-runtime.js";

describe("data source runtimes", () => {
  it("passes client environment to provider", async () => {
    const registry = new DataSourceProviderRegistry();
    const seen: string[] = [];

    registry.register({
      id: "countries",
      load: async (_request, context) => {
        seen.push(context.environment);
        return { items: [{ value: "CA", label: "Canada" }] };
      }
    });

    const runtime = new ClientDataSourceRuntime(registry);
    const result = await runtime.load("countries", { sourceId: "countries" }, { locale: "en-CA" });

    expect(result.items[0]?.value).toBe("CA");
    expect(seen).toEqual(["client"]);
  });

  it("passes server environment to provider", async () => {
    const registry = new DataSourceProviderRegistry();
    const seen: string[] = [];

    registry.register({
      id: "countries",
      load: async (_request, context) => {
        seen.push(context.environment);
        return { items: [{ value: "CA", label: "Canada" }] };
      }
    });

    const runtime = new ServerDataSourceRuntime(registry);
    await runtime.load("countries", { sourceId: "countries" }, { locale: "fr-CA" });

    expect(seen).toEqual(["server"]);
  });

  it("errors for unknown providers", async () => {
    const registry = new DataSourceProviderRegistry();
    const runtime = new ClientDataSourceRuntime(registry);

    await expect(runtime.load("missing", { sourceId: "missing" })).rejects.toThrow(
      /not found/
    );
  });

  it("rejects a server-only provider from the client runtime", async () => {
    const registry = new DataSourceProviderRegistry();
    registry.register({
      id: "ledger",
      environments: ["server"],
      load: async () => ({ items: [] })
    });

    const client = new ClientDataSourceRuntime(registry);
    await expect(client.load("ledger", { sourceId: "ledger" })).rejects.toThrow(
      /provider "ledger" is available in the client environment/
    );

    const server = new ServerDataSourceRuntime(registry);
    await expect(server.load("ledger", { sourceId: "ledger" })).resolves.toEqual({ items: [] });
  });

  it("allows a provider that declares both environments (or none) from either runtime", async () => {
    const registry = new DataSourceProviderRegistry();
    registry.register({
      id: "both",
      environments: ["client", "server"],
      load: async (_request, context) => ({
        items: [{ value: context.environment, label: context.environment }]
      })
    });

    const client = new ClientDataSourceRuntime(registry);
    const server = new ServerDataSourceRuntime(registry);
    expect((await client.load("both", { sourceId: "both" })).items[0]?.value).toBe("client");
    expect((await server.load("both", { sourceId: "both" })).items[0]?.value).toBe("server");
  });
});
