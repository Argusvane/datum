import { describe, expect, it } from "vitest";

import type { FormPlugin, FormulaFunctionContribution } from "../form-engine/core/schema/contracts.js";
import { FormulaFunctionRegistry } from "../form-engine/registry/formula-functions/formula-function-registry.js";
import { formulaFunctionParity } from "../form-engine/validation/parity/formula-function-parity.js";
import { PluginPlatform, type PluginPlatformRegistries } from "../form-engine/plugins/platform/plugin-platform.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";

const double: FormulaFunctionContribution = {
  name: "double",
  params: ["n"],
  summary: "Twice a number.",
  example: "double(2)",
  returns: "number",
  evaluate: (args) => (typeof args[0] === "number" ? args[0] * 2 : undefined)
};

describe("FormulaFunctionRegistry", () => {
  it("registers a function and lists it as functions, signatures and table rows", () => {
    const registry = new FormulaFunctionRegistry();
    registry.register(double, "p1");
    registry.register(
      { name: "pick", params: ["a", "b?"], summary: "s", example: "pick(1)", evaluate: () => 1, snippets: [{ label: "x", insert: "pick()" }] },
      "p1"
    );
    registry.register({ name: "total", params: ["n"], variadic: true, min: 1, summary: "s", example: "e", evaluate: () => 0 }, "p2");
    expect(registry.functions().double?.([4])).toBe(8);
    expect(registry.signatures()).toEqual([
      { name: "double", min: 1, max: 1 },
      { name: "pick", min: 1, max: 2 },
      { name: "total", min: 1, max: Infinity }
    ]);
    const rows = registry.table();
    expect(rows[0]).toMatchObject({ name: "double", returns: "number", plugin: "p1" });
    expect(rows[1]).toMatchObject({ returns: "any", snippets: [{ label: "x", insert: "pick()" }] });
    expect(rows[2]).toMatchObject({ variadic: true, min: 1, plugin: "p2" });
  });

  it("refuses a built-in name, a duplicate and a malformed contribution", () => {
    const registry = new FormulaFunctionRegistry();
    expect(() => registry.register({ ...double, name: "sum" }, "p1")).toThrow(/built-in/);
    registry.register(double, "p1");
    expect(() => registry.register(double, "p2")).toThrow(/already registered by plugin "p1"/);
    expect(() => registry.register({ ...double, name: "bad name" }, "p1")).toThrow(/needs a name/);
    expect(() => registry.register({ ...double, name: "x", evaluate: undefined as never }, "p1")).toThrow(/evaluate/);
  });

  it("refuses a name that is object plumbing rather than a function, naming the plugin", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const registry = new FormulaFunctionRegistry();
      expect(() => registry.register({ ...double, name }, "evil")).toThrow(
        new RegExp(`"${name}" from plugin "evil" uses a reserved name`)
      );
      // Nothing half-registered: not callable, not a signature, not a table row, no pollution.
      expect(Object.keys(registry.functions())).toEqual([]);
      expect(Object.getPrototypeOf(registry.functions())).toBe(Object.prototype);
      expect(registry.signatures()).toEqual([]);
      expect(registry.table()).toEqual([]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

function registries(withFunctions: boolean): PluginPlatformRegistries {
  return {
    plugins: new PluginRegistry(),
    components: new ComponentRegistry(),
    validators: new ValidatorRegistry(),
    dataSourceProviders: new DataSourceProviderRegistry(),
    dataSources: new DataSourceRegistry(),
    ...(withFunctions ? { formulaFunctions: new FormulaFunctionRegistry() } : {})
  };
}

describe("plugin platform formula functions", () => {
  it("merges the installed plugins' functions into the result", () => {
    const regs = registries(true);
    const plugin: FormPlugin = { id: "calc", version: "1.0.0", formulaFunctions: [double] };
    regs.plugins.register(plugin);
    const platform = new PluginPlatform(regs);
    const result = platform.installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).toEqual(["calc"]);
    expect(result.mergedFormulaFunctions.double?.([3])).toBe(6);
    expect(platform.formulaFunctions?.signatures()).toEqual([{ name: "double", min: 1, max: 1 }]);
  });

  it("fails the one plugin whose function collides, leaving the others installed", () => {
    const regs = registries(true);
    regs.plugins.register({ id: "a", version: "1.0.0", formulaFunctions: [double] });
    regs.plugins.register({ id: "b", version: "1.0.0", formulaFunctions: [double] });
    const errors: unknown[] = [];
    const result = new PluginPlatform(regs, { onError: (error) => errors.push(error) }).installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).toEqual(["a"]);
    expect(result.failedPluginIds).toEqual(["b"]);
    expect(String(errors[0])).toMatch(/already registered/);
  });

  it("reports a plugin that contributes functions to a platform with no registry", () => {
    const regs = registries(false);
    regs.plugins.register({ id: "a", version: "1.0.0", formulaFunctions: [double] });
    const result = new PluginPlatform(regs).installAndInitialize({ environment: "browser" });
    expect(result.failedPluginIds).toEqual(["a"]);
    expect(result.mergedFormulaFunctions).toEqual({});
  });
});

describe("formulaFunctionParity", () => {
  it("reports a vector where the sandbox disagrees", async () => {
    const report = await formulaFunctionParity(
      double,
      [{ args: [2], expected: 4 }, { args: ["x"], expected: undefined }, { args: [3], expected: 6 }],
      (_name, args) => (args[0] === 3 ? 7 : double.evaluate(args))
    );
    expect(report.checked).toBe(3);
    expect(report.mismatches.map((m) => m.index)).toEqual([2]);
  });
});
