import { describe, expect, it } from "vitest";

import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";

describe("registry coverage", () => {
  it("resolves latest registered validator/plugin", () => {
    const validators = new ValidatorRegistry();
    validators.register({ id: "required", version: "1.0.0", validate: () => ({ errors: [] }) });
    expect(validators.resolve("required").id).toBe("required");

    const plugins = new PluginRegistry();
    plugins.register({ id: "base-plugin", version: "1.0.0" });
    expect(plugins.resolve("base-plugin").version).toBe("1.0.0");
  });

  it("keeps datasource registry resolving latest", () => {
    const dataSources = new DataSourceRegistry();
    dataSources.register({ id: "countries", providerId: "a", version: "1.0.0" });
    dataSources.register({ id: "countries", providerId: "b", version: "1.1.0" });
    expect(dataSources.resolve("countries").providerId).toBe("b");
  });

  it("resolves plugin dependency order and detects cycles", () => {
    const plugins = new PluginRegistry();
    plugins.register({ id: "base", version: "1.0.0" });
    plugins.register({ id: "feature", version: "1.0.0", dependencies: [{ id: "base" }] });

    expect(plugins.resolveDependencyOrder().map((plugin) => plugin.id)).toEqual([
      "base",
      "feature"
    ]);

    const cyclic = new PluginRegistry();
    cyclic.register({ id: "a", version: "1.0.0", dependencies: [{ id: "b" }] });
    cyclic.register({ id: "b", version: "1.0.0", dependencies: [{ id: "a" }] });

    expect(() => cyclic.resolveDependencyOrder()).toThrow(/cycle/);
  });

  it("errors when plugin dependency is missing", () => {
    const plugins = new PluginRegistry();
    plugins.register({ id: "feature", version: "1.0.0", dependencies: [{ id: "base" }] });

    expect(() => plugins.resolveDependencyOrder()).toThrow(/not found/);
  });
});
