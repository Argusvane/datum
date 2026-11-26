import { describe, expect, it } from "vitest";

import { defineDataSources } from "../form-engine/data/host/data-source-set.js";
import { StaticDataSourceProvider } from "../form-engine/data/providers/static-data-source-provider.js";
import { RemoteDataSourceProvider } from "../form-engine/data/providers/remote-data-source-provider.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { RegisteredClientDataSourceRuntime } from "../form-engine/data/client/registered-client-data-source-runtime.js";
import { createHostDataSourceResolver, resolveThroughDataSourceSet, timedDataSourceSet, withDataSourceTimeout } from "../form-engine/render/core/host-data-sources.js";
import { buildRuntimeRenderOutput } from "../form-engine/render/core/runtime-render-bridge.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { DataSourceContext, DataSourceRequest } from "../form-engine/core/schema/contracts.js";

const COUNTRIES = [
  { value: "CA", label: "Canada" },
  { value: "US", label: "United States" }
];

describe("defineDataSources", () => {
  it("serves a fixed list, copied so callers cannot edit the definition", async () => {
    const sources = defineDataSources({ countries: COUNTRIES });
    const first = await sources.load("countries");
    first.items[0]!.label = "changed";
    const second = await sources.load("countries");
    expect(second.items[0]?.label).toBe("Canada");
    expect(sources.has("countries")).toBe(true);
    expect(sources.has("cities")).toBe(false);
    expect(sources.ids()).toEqual(["countries"]);
  });

  it("calls a loader with the request and a context carrying the environment, accepting a bare array back", async () => {
    const seen: Array<{ request: DataSourceRequest; context: DataSourceContext }> = [];
    const sources = defineDataSources({
      cities: (request, context) => {
        seen.push({ request, context });
        return context.values?.country === "CA" ? [{ value: "YOW", label: "Ottawa" }] : { items: [] };
      }
    });
    const result = await sources.load("cities", { limit: 5 }, { locale: "fr-CA", values: { country: "CA" } });
    expect(result.items).toEqual([{ value: "YOW", label: "Ottawa" }]);
    expect(seen[0]?.request).toEqual({ sourceId: "cities", query: { limit: 5 } });
    expect(seen[0]?.context).toEqual({ locale: "fr-CA", values: { country: "CA" }, environment: "client" });
    expect((await sources.load("cities", {}, { values: { country: "US" } })).items).toEqual([]);
  });

  it("wraps a provider, honouring the environment it declares", async () => {
    const sources = defineDataSources({
      countries: new StaticDataSourceProvider("static-countries", COUNTRIES),
      products: new RemoteDataSourceProvider("products", "https://example.test/options", async () => new Response("{}"), {
        environments: ["server"]
      })
    });
    expect((await sources.load("countries")).items).toEqual(COUNTRIES);
    await expect(sources.load("products")).rejects.toThrow(/not available in the client environment/);
    const server = defineDataSources(
      { products: new RemoteDataSourceProvider("products", "https://example.test/options", async () => new Response('{"items":[]}'), { environments: ["server"] }) },
      { environment: "server" }
    );
    expect((await server.load("products")).items).toEqual([]);
  });

  it("refuses an id it does not hold, and an input it cannot read", async () => {
    const sources = defineDataSources({ countries: COUNTRIES });
    await expect(sources.load("cities")).rejects.toThrow('No data source defined for id: cities');
    expect(() => defineDataSources({ broken: "nope" as unknown as never })).toThrow(/must be an array of items/);
  });
});

describe("host data sources in the render bridge", () => {
  function makeRuntime(root: ComponentNode, dataSources?: RegisteredClientDataSourceRuntime): FormRuntime {
    const form: FormDefinition = {
      id: "f1",
      version: "1",
      schemaVersion: "1",
      root,
      localization: { defaultLocale: "en" }
    };
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(form, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      ...(dataSources ? { dataSources } : {})
    });
  }

  function registered(): RegisteredClientDataSourceRuntime {
    const providers = new DataSourceProviderRegistry();
    providers.register(new StaticDataSourceProvider("static-methods", [{ value: "email", label: "Email" }]));
    const definitions = new DataSourceRegistry();
    definitions.register({ id: "contact-methods", providerId: "static-methods", version: "1.0.0" });
    return new RegisteredClientDataSourceRuntime(definitions, providers);
  }

  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } },
        { id: "method", type: "radio", configuration: { label: "Method", data: { sourceId: "contact-methods" } } },
        { id: "answer", type: "select", configuration: { label: "Answer", options: [{ value: "y", label: "Yes" }] } }
      ]
    }
  };

  it("asks the host's set first and falls back to the runtime's registered sources", async () => {
    const runtime = makeRuntime(root, registered());
    const resolver = createHostDataSourceResolver(runtime, defineDataSources({ countries: COUNTRIES }));
    expect((await resolver.resolveDataSource({ componentId: "country" }))?.items).toEqual(COUNTRIES);
    expect((await resolver.resolveDataSource({ componentId: "method" }))?.items).toEqual([{ value: "email", label: "Email" }]);
    expect(await resolver.resolveDataSource({ componentId: "answer" })).toBeUndefined();
  });

  it("hands a loader the form's locale and values", async () => {
    const runtime = makeRuntime(root);
    runtime.setValue("answer", "y");
    const contexts: DataSourceContext[] = [];
    const resolver = createHostDataSourceResolver(
      runtime,
      defineDataSources({
        countries: (_request, context) => {
          contexts.push(context);
          return COUNTRIES;
        }
      })
    );
    await resolver.resolveDataSource({ componentId: "country" });
    expect(contexts[0]).toMatchObject({ locale: "en", environment: "client", values: { answer: "y" } });
  });

  it("renders a select from a wiring-time set with no data-source runtime on the form at all", async () => {
    const runtime = makeRuntime(root);
    const output = await buildRuntimeRenderOutput(runtime, "interactive", {
      dataSources: defineDataSources({ countries: COUNTRIES })
    });
    const byId = new Map(output.components.map((model) => [model.id, model]));
    expect(byId.get("country")?.optionState.items).toEqual(COUNTRIES);
    // Not in the set, and the runtime has no registered sources: an error, reported as such.
    expect(byId.get("method")?.optionState.status).toBe("error");
    // Inline options still apply to a component naming no source.
    expect(byId.get("answer")?.optionState.items).toEqual([{ value: "y", label: "Yes" }]);
  });
});

describe("timedDataSourceSet", () => {
  it("fails a load that outlasts the limit, naming the source, and keeps has/ids", async () => {
    const set = defineDataSources({ slow: () => new Promise(() => undefined), fast: COUNTRIES });
    const timed = timedDataSourceSet(set, 30);
    expect(timed.has("slow")).toBe(true);
    expect(timed.ids()).toEqual(["slow", "fast"]);
    await expect(timed.load("slow")).rejects.toThrow(/"slow" did not answer within 30 ms/);
    expect((await timed.load("fast")).items).toHaveLength(2);
  });

  it("is the set itself for no limit, and passes a synchronous throw on as a rejection", async () => {
    const set = defineDataSources({ x: COUNTRIES });
    expect(timedDataSourceSet(set, 0)).toBe(set);
    const throwing = { has: () => true, ids: () => ["t"], load: () => { throw new Error("sync"); } };
    await expect(timedDataSourceSet(throwing as never, 30).load("t")).rejects.toThrow("sync");
  });

  it("withDataSourceTimeout returns the promise untouched for no limit", async () => {
    const promise = Promise.resolve(1);
    expect(withDataSourceTimeout(promise, 0, "x")).toBe(promise);
  });
});

describe("a source that answers nothing has failed", () => {
  const lookup = {
    node: { id: "country", type: "select", configuration: { data: { sourceId: "src" } } } as ComponentNode,
    request: { componentId: "country" },
    locale: "en",
    values: {}
  };

  it.each([["null", null], ["undefined", undefined]])("a host loader answering %s rejects, naming the source, instead of reading as no source", async (_name, answer) => {
    const set = defineDataSources({ src: (() => answer) as never });
    await expect(resolveThroughDataSourceSet(set, lookup)).rejects.toThrow('The data source "src" answered nothing');
  });

  it("still answers undefined, the no-source signal, for an id the set does not hold", () => {
    expect(resolveThroughDataSourceSet(defineDataSources({ other: COUNTRIES }), lookup)).toBeUndefined();
  });
});
