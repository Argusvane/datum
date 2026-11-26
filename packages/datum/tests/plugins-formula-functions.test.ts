import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import { createPluginPlatform } from "../src/plugins.js";
import type { DatumFormElement } from "../src/form.js";
import type { FormDefinition, FormPlugin } from "@argusvane/datum-engine";

import { until } from "./helpers.js";
import { control, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const DOUBLE_PLUGIN: FormPlugin = {
  id: "double-plugin",
  version: "1.0.0",
  formulaFunctions: [
    {
      name: "double",
      params: ["value"],
      summary: "Twice a number.",
      example: "double(2)",
      returns: "number",
      evaluate: (args) => Number(args[0]) * 2
    }
  ]
};

function definition(): FormDefinition {
  return {
    id: "doubling",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Doubling" },
      children: {
        content: [
          { id: "employees", type: "number", configuration: { label: "Employees" } },
          { id: "doubled", type: "number", configuration: { label: "Doubled" }, rules: { value: "double(employees)" } }
        ]
      }
    }
  } as unknown as FormDefinition;
}

describe("plugin formula functions on the form element", () => {
  it("gives the platform a formula function registry that holds a plugin's function", () => {
    const platform = createPluginPlatform([DOUBLE_PLUGIN]);
    platform.installAndInitialize({ environment: "browser" });
    expect(platform.formulaFunctions).toBeDefined();
    expect(platform.formulaFunctions!.functions().double?.([4])).toBe(8);
  });

  it("computes a rule that calls the function in the browser, with no unknown-function warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition();
    element.plugins = [DOUBLE_PLUGIN];
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    const form = element.renderer!.shadowRoot!;
    type(control(form, "employees"), "21");
    await until(() => element.values.doubled === 42);
    expect(element.values.doubled).toBe(42);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => /Unknown function/.test(line))).toEqual([]);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => /failed to install/.test(line))).toEqual([]);
  });

  it("warns, naming the plugin, when a plugin fails to install", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clash: FormPlugin = {
      id: "clash-plugin",
      version: "1.0.0",
      formulaFunctions: [{ name: "concat", params: ["a"], summary: "", example: "", evaluate: () => "" }]
    };
    const platform = createPluginPlatform([clash]);
    const result = platform.installAndInitialize({ environment: "browser" });
    expect(result.failedPluginIds).toContain("clash-plugin");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/clash-plugin.*built-in/);
  });
});

describe("plugins named in the submission envelope", () => {
  it("reports the installed plugin and its version under versionContext.client.plugins", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition();
    element.plugins = [{ ...DOUBLE_PLUGIN, id: "demo-double", version: "1.2.3" }];
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("form"));
    const form = element.renderer!.shadowRoot!;
    type(control(form, "employees"), "21");
    await until(() => element.values.doubled === 42);
    const detail = await element.submit();
    expect(detail.accepted).toBe(true);
    expect(detail.submission!.versionContext.client.plugins).toEqual({ "demo-double": "1.2.3" });
  });
});
