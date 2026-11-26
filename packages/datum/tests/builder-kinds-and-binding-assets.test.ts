import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { bindings, type LiveBinding } from "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { createPluginRegistry } from "../src/plugins.js";
import type { ComponentDefinition, FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/*
 * What a binding or a plugin needs of the builder: the saved definition carries
 * the `kinds` map for every tier-2 or plugin type the form uses, and a binding registered with its
 * design system's files draws the canvas with them when the author picks it.
 */
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const named = (id: string, extra: Partial<LiveBinding> = {}): LiveBinding => ({ id, label: `Label ${id}`, components: {}, ...extra });

const acmeDate: ComponentDefinition = {
  type: "acme-date",
  version: "1.0.0",
  base: "date",
  createDefault: () => ({ id: "acme_date", type: "acme-date", configuration: { label: "Date" } }),
  capabilities: []
};

function withTypes(definition: FormDefinition, extra: FormDefinition["root"][]): FormDefinition {
  const content = definition.root.children?.content ?? [];
  return { ...definition, root: { ...definition.root, children: { ...definition.root.children, content: [...content, ...extra] } } };
}

async function mounted(definition: FormDefinition, setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

describe("<datum-form-builder> writes the definition's kinds map", () => {
  it("names the base of each plugin and binding type the form uses, from the plugin's definition and the registered bindings", async () => {
    bindings.register(named("wc-kinds-ds", { kinds: { "ds-radios": "radio", "ds-unused": "text" } }));
    const registry = createPluginRegistry().register({ id: "acme", version: "1.0.0", components: [acmeDate] });
    const definition = withTypes(sampleDefinition(), [
      { id: "born", type: "acme-date", configuration: { label: "Born" } },
      { id: "colour", type: "ds-radios", configuration: { label: "Colour", options: [{ value: "red", label: "Red" }] } }
    ]);
    const element = await mounted(definition, (el) => {
      el.pluginRegistry = registry;
    });
    await until(() => element.definition.kinds?.["acme-date"] === "date");
    expect(element.definition.kinds).toEqual({ "acme-date": "date", "ds-radios": "radio" });
  });

  it("writes no map for a form of engine types, and hands back the map a form was loaded with while nothing changes it", async () => {
    const plain = await mounted(sampleDefinition());
    expect(plain.definition).not.toHaveProperty("kinds");
    plain.remove();
    const kinds = { "loaded-date": "date" };
    const loaded = withTypes({ ...sampleDefinition(), kinds }, [{ id: "when", type: "loaded-date", configuration: { label: "When" } }]);
    const element = await mounted(loaded);
    // Nothing on the page offers the type: the entry it was loaded with stands, as the same object.
    expect(element.definition.kinds).toBe(kinds);
    // Try it reads the same map through the controller (formKinds), so it checks `when` as a date as Save writes it.
    const controller = element.controller!;
    expect(controller.openedKinds?.()).toBe(kinds);
    expect(controller.definitionKinds(controller.openedKinds?.())).toBe(kinds);
    // A definition seeded later is the one read.
    const next = { "loaded-date": "text" };
    element.definition = { ...loaded, kinds: next };
    await until(() => element.controller?.openedKinds?.() === next);
    expect(element.controller!.definitionKinds(element.controller!.openedKinds?.())).toBe(next);
  });
});

describe("bindings registered with their design system's files", () => {
  it("draw the builder's canvas with those files when the author picks the binding", async () => {
    const assets = { stylesheets: [{ url: "https://ds.test/wc-assets.css" }] };
    bindings.register(named("wc-assets-ds"), { assets });
    expect(bindings.assets("wc-assets-ds")).toBe(assets);
    const element = await mounted(sampleDefinition());
    const controller = element.controller!;
    expect(controller.availableBindings().find((option) => option.id === "wc-assets-ds")?.assets).toBe(assets);
    expect(controller.availableBindings().find((option) => option.id === "datum")?.assets).toBeUndefined();
    controller.setBindingId("wc-assets-ds");
    expect(controller.canvasAssets()).toBe(assets);
    // Registered again with other files, the picker follows.
    const next = { stylesheets: [{ url: "https://ds.test/wc-assets-2.css" }] };
    bindings.register(bindings.get("wc-assets-ds")!, { assets: next });
    await until(() => controller.canvasAssets() === next);
  });
});
