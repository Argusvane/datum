import { describe, expect, it } from "vitest";

import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";
import { readFileSync } from "node:fs";
import { ENGINE_VERSION } from "../form-engine/registry/engine-version.js";
import { PluginPlatform } from "../form-engine/plugins/platform/plugin-platform.js";

describe("plugin platform", () => {
  function registries() {
    return {
      plugins: new PluginRegistry(),
      components: new ComponentRegistry(),
      validators: new ValidatorRegistry(),
      dataSourceProviders: new DataSourceProviderRegistry(),
      dataSources: new DataSourceRegistry()
    };
  }

  it("installs contributions and initializes in dependency order", () => {
    const regs = registries();
    const initOrder: string[] = [];

    regs.plugins.register({
      id: "base",
      version: "1.0.0",
      components: [
        {
          type: "text",
          version: "1.0.0",
          createDefault: () => ({ id: "t", type: "text", configuration: {} }),
          capabilities: []
        }
      ],
      initialize: () => initOrder.push("base")
    });

    regs.plugins.register({
      id: "feature",
      version: "1.0.0",
      dependencies: [{ id: "base" }],
      validators: [{ id: "required", version: "1.0.0", validate: () => ({ errors: [] }) }],
      dataSourceProviders: [
        {
          id: "countries-provider",
          load: async () => ({ items: [{ value: "CA", label: "Canada" }] })
        }
      ],
      dataSources: [
        {
          id: "countries",
          providerId: "countries-provider",
          version: "1.0.0"
        }
      ],
      initialize: () => initOrder.push("feature")
    });

    const platform = new PluginPlatform(regs);
    const result = platform.installAndInitialize({ environment: "browser" });

    expect(initOrder).toEqual(["base", "feature"]);
    expect(result.installedPluginIds).toEqual(["base", "feature"]);
    expect(result.failedPluginIds).toEqual([]);
    expect(regs.components.resolve("text").type).toBe("text");
    expect(regs.validators.resolve("required").id).toBe("required");
    expect(regs.dataSourceProviders.resolve("countries-provider").id).toBe("countries-provider");
    expect(regs.dataSources.resolve("countries").providerId).toBe("countries-provider");
  });

  it("isolates install and initialize failures", () => {
    const regs = registries();
    const initialized: string[] = [];

    regs.plugins.register({
      id: "broken",
      version: "1.0.0",
      components: [
        {
          type: "dup",
          version: "1.0.0",
          createDefault: () => ({ id: "a", type: "dup", configuration: {} }),
          capabilities: []
        },
        {
          type: "dup",
          version: "1.0.0",
          createDefault: () => ({ id: "b", type: "dup", configuration: {} }),
          capabilities: []
        }
      ],
      initialize: () => {
        initialized.push("broken");
      }
    });

    regs.plugins.register({
      id: "ok",
      version: "1.0.0",
      initialize: () => initialized.push("ok")
    });

    const seenErrors: string[] = [];
    const platform = new PluginPlatform(regs, {
      onError: (error) => {
        seenErrors.push(error instanceof Error ? error.message : String(error));
      }
    });

    const result = platform.installAndInitialize({ environment: "browser" });

    expect(initialized).toEqual(["ok"]);
    expect(result.installedPluginIds).toContain("ok");
    expect(result.failedPluginIds).toContain("broken");
    expect(seenErrors.some((message) => message.includes("already registered"))).toBe(true);
  });

  it("collects contributed wasm plugin modules for the host to wire in at startup", () => {
    const regs = registries();

    regs.plugins.register({
      id: "custom-validation",
      version: "1.0.0",
      wasmPlugin: {
        id: "custom-validation",
        version: "1.0.0",
        source: "({ validators: [(context) => ({ errors: [] })] })"
      }
    });
    regs.plugins.register({ id: "no-wasm", version: "1.0.0" });

    const result = new PluginPlatform(regs).installAndInitialize({ environment: "browser" });

    expect(result.mergedWasmPlugins).toEqual([
      {
        id: "custom-validation",
        version: "1.0.0",
        source: "({ validators: [(context) => ({ errors: [] })] })"
      }
    ]);
  });

  it("collects contributed validators, in install order, for the runtime's pipeline", () => {
    const regs = registries();
    const first = { id: "first", version: "1.0.0", validate: () => ({ errors: [] }) };
    const second = { id: "second", version: "1.0.0", validate: () => ({ errors: [] }) };
    regs.plugins.register({ id: "a", version: "1.0.0", validators: [first] });
    regs.plugins.register({ id: "b", version: "1.0.0", validators: [second] });
    // A plugin the platform rejects contributes nothing.
    regs.plugins.register({ id: "server-only", version: "1.0.0", environments: ["server"], validators: [{ id: "never", version: "1.0.0", validate: () => ({ errors: [] }) }] });

    const result = new PluginPlatform(regs).installAndInitialize({ environment: "browser" });

    expect(result.mergedValidators).toEqual([first, second]);
    expect(result.incompatiblePluginIds).toEqual(["server-only"]);
  });
  it("ENGINE_VERSION is the engine package's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("refuses a plugin whose engineRange the engine does not satisfy, with no policy given, and reports it", () => {
    const regs = registries();
    regs.plugins.register({ id: "future", version: "1.0.0", engineRange: "^99.0.0", components: [{ type: "future-box", version: "1.0.0", createDefault: () => ({ id: "f", type: "future-box", configuration: {} }), capabilities: [] } as never] });
    regs.plugins.register({ id: "now", version: "1.0.0", engineRange: `^${ENGINE_VERSION}` });
    const seen: string[] = [];
    const result = new PluginPlatform(regs, { onIncompatible: (id) => seen.push(id) }).installAndInitialize({ environment: "browser" });
    expect(result.incompatiblePluginIds).toEqual(["future"]);
    expect(result.installedPluginIds).toEqual(["now"]);
    expect(seen).toEqual(["future"]);
    expect(regs.components.list("future-box")).toHaveLength(0);
  });

  it("a plugin that fails part-way leaves none of its contributions registered, and later plugins still install", () => {
    const regs = registries();
    const component = (type: string) => ({ type, version: "1.0.0", createDefault: () => ({ id: type, type, configuration: {} }), capabilities: [] }) as never;
    regs.plugins.register({ id: "a", version: "1.0.0", components: [component("shared")] });
    regs.plugins.register({ id: "b", version: "1.0.0", dependencies: [{ id: "a", versionRange: "*" }], components: [component("b-own"), component("shared")] });
    regs.plugins.register({ id: "c", version: "1.0.0", dependencies: [{ id: "a", versionRange: "*" }], components: [component("c-own")] });
    const result = new PluginPlatform(regs, { onError: () => undefined }).installAndInitialize({ environment: "browser" });
    expect(result.failedPluginIds).toContain("b");
    expect(result.installedPluginIds).toContain("c");
    expect(regs.components.list("b-own")).toHaveLength(0);
    expect(regs.components.list("shared")).toHaveLength(1);
    expect(regs.components.list("c-own")).toHaveLength(1);
  });
});
