import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { FormPlugin } from "../../engine/form-engine/core/schema/contracts";
import type { BindingFactory, LiveAssets, LiveBinding, ScriptSource } from "../../engine/form-engine/render/live/contract";
import { bindingAssetsById, bindingById, registerBinding, registeredBindings } from "../../engine/form-engine/render/live/binding-registry";
import { createDatumBinding } from "../../engine/form-engine/render/live/datum/options";
import { lit } from "../../engine/form-engine/render/live/lit";
import { PluginRegistry } from "../../engine/form-engine/registry/plugins/plugin-registry";
// @ts-expect-error the spec is a plain module shared with the copy script
import { REFERENCE_BINDINGS } from "../scripts/binding-assets-spec.mjs";

// Every reference binding package under bindings/<id> loads as a module and registers the way a
// host registers it (`bindings.register`, the web components' own `bindings.fromFactory` being
// this call): its factory answers a binding of its own id, its design-system file list becomes the
// registered asset list, and its FormPlugin (the four design systems that have component types of
// their own) is a plugin the engine's registry takes. The pages and the kit measure the same
// packages in a browser; this is the one node-side guard that each package imports at all.

const root = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const ids: string[] = REFERENCE_BINDINGS;

/** The packages that ship a FormPlugin beside the binding, and the export it is under. */
const PLUGIN_EXPORTS: Readonly<Record<string, string>> = { gcds: "gcdsPlugin", alberta: "albertaPlugin", ontario: "ontarioPlugin", quebec: "quebecPlugin" };

interface CheckFile {
  stylesheets: string[];
  scripts?: Array<string | { url: string; classic?: boolean; attributes?: Record<string, string> }>;
}

/** The design system's files as the package's binding-check.json lists them, as an asset list a host would register. */
function assetsOf(id: string): LiveAssets {
  const check = JSON.parse(readFileSync(join(root, "bindings", id, "binding-check.json"), "utf8")) as CheckFile;
  const scripts: ScriptSource[] = (check.scripts ?? []).map((script) =>
    typeof script === "string" ? { url: `/ds${script}` } : { url: `/ds${script.url}`, ...(script.classic === true ? { classic: true } : {}) }
  );
  return { stylesheets: check.stylesheets.map((url) => ({ url: `/ds${url}` })), ...(scripts.length > 0 ? { scripts } : {}) };
}

/** A package's module, from the entry its package.json exports. */
async function moduleOf(id: string): Promise<Record<string, unknown>> {
  const pack = JSON.parse(readFileSync(join(root, "bindings", id, "package.json"), "utf8")) as { exports: { ".": { import: string } } };
  const entry = join(root, "bindings", id, pack.exports["."].import);
  expect(existsSync(entry), `${id}: ${entry}`).toBe(true);
  return (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Record<string, unknown>;
}

describe("the reference binding packages", () => {
  it("are the nine under bindings/<id>, each with a package that says so", () => {
    expect(ids).toHaveLength(9);
    for (const id of ids) {
      const pack = JSON.parse(readFileSync(join(root, "bindings", id, "package.json"), "utf8")) as { datumBinding: { id: string } };
      expect(pack.datumBinding.id, id).toBe(id);
    }
  });

  it("each import as a module whose factory makes a binding of its own id, drawing the engine's component types", async () => {
    const datum = createDatumBinding();
    for (const id of ids) {
      const module = await moduleOf(id);
      expect(typeof module.createBinding, id).toBe("function");
      const binding = (module.createBinding as BindingFactory)(lit, datum);
      expect(binding.id, id).toBe(id);
      expect(binding.label, id).toBeTruthy();
      // A binding draws leaves of its own at least; everything else falls through to Datum's.
      expect(Object.keys(binding.components).length, id).toBeGreaterThan(0);
      expect(Object.keys(binding.components), id).toEqual(expect.arrayContaining(["text"]));
    }
  });

  it("each register with the files of its design system, once, and answer by id afterwards", async () => {
    const datum = createDatumBinding();
    const made = new Map<string, LiveBinding>();
    for (const id of ids) {
      const module = await moduleOf(id);
      const binding = (module.createBinding as BindingFactory)(lit, datum);
      made.set(id, binding);
      const assets = assetsOf(id);
      expect(assets.stylesheets?.length, id).toBeGreaterThan(0);
      registerBinding(binding, { assets });
      expect(bindingById(id), id).toBe(binding);
      expect(bindingAssetsById(id), id).toEqual(assets);
    }
    expect(registeredBindings().map((binding) => binding.id)).toEqual(expect.arrayContaining(ids));
    // Registered again with the same object, nothing moves.
    for (const [id, binding] of made) {
      registerBinding(binding, { assets: assetsOf(id) });
      expect(bindingById(id), id).toBe(binding);
    }
    // Datum's own binding is never registered, whatever asks.
    expect(bindingById("datum")).toBeUndefined();
  });

  it("each bring a FormPlugin only where the design system has component types of its own, and the engine registry takes it", async () => {
    const plugins = new PluginRegistry();
    for (const id of ids) {
      const module = await moduleOf(id);
      const exported = Object.keys(module).filter((name) => /Plugin$/.test(name));
      if (PLUGIN_EXPORTS[id] === undefined) {
        expect(exported, id).toEqual([]);
        continue;
      }
      expect(exported, id).toEqual([PLUGIN_EXPORTS[id]]);
      const plugin = module[PLUGIN_EXPORTS[id]!] as FormPlugin;
      expect(typeof plugin.id, id).toBe("string");
      expect(plugin.version, id).toMatch(/^\d+\.\d+\.\d+/);
      const types = (plugin.components ?? []).map((component) => component.type);
      expect(types.length, id).toBeGreaterThan(0);
      // The types are the design system's own, each with what the builder needs to place one.
      for (const component of plugin.components ?? []) {
        expect(typeof component.createDefault, `${id}: ${component.type}`).toBe("function");
        expect(component.palette?.label, `${id}: ${component.type}`).toBeTruthy();
      }
      plugins.register(plugin);
      expect(plugins.resolve(plugin.id).id).toBe(plugin.id);
      expect(() => plugins.register(plugin), id).toThrow(/already registered/);
    }
  });
});
