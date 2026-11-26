import { describe, expect, it } from "vitest";

import { RemoteDataSourceProvider } from "../form-engine/data/providers/remote-data-source-provider.js";

describe("remote data source provider", () => {
  it("posts source request and maps response", async () => {
    let calledUrl = "";
    let calledBody = "";

    const provider = new RemoteDataSourceProvider(
      "remote",
      "https://example.test/data",
      async (input, init) => {
        calledUrl = input;
        calledBody = String(init?.body ?? "");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [{ value: "CA", label: "Canada" }]
          })
        } as Response;
      }
    );

    const result = await provider.load(
      { sourceId: "countries", query: { region: "americas" } },
      { environment: "client", locale: "en-CA", values: { tenant: "acme" } }
    );

    expect(calledUrl).toContain("sourceId=countries");
    expect(calledUrl).toContain("locale=en-CA");
    expect(calledBody).toContain('"region":"americas"');
    expect(result.items).toHaveLength(1);
  });

  it("throws on non-2xx response", async () => {
    const provider = new RemoteDataSourceProvider(
      "remote",
      "https://example.test/data",
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => ({})
        }) as Response
    );

    await expect(
      provider.load({ sourceId: "countries" }, { environment: "server" })
    ).rejects.toThrow(/503/);
  });
});
