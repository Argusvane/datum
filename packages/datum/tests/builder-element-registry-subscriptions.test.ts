import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { createPluginRegistry, type DatumPluginRegistry } from "../src/plugins.js";
import { createThemeRegistry, type DatumThemeRegistry } from "../src/themes.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** A registry whose subscriptions are counted: `active` is how many are still held. */
function counted<T extends { subscribe(listener: () => void): () => void }>(registry: T): { registry: T; active: () => number } {
  let active = 0;
  const wrapped = Object.create(registry) as T;
  wrapped.subscribe = (listener) => {
    active += 1;
    const off = registry.subscribe(listener);
    let held = true;
    return () => {
      if (held) {
        held = false;
        active -= 1;
        off();
      }
    };
  };
  return { registry: wrapped, active: () => active };
}

const plugins = (): { registry: DatumPluginRegistry; active: () => number } => counted(createPluginRegistry());
const themes = (): { registry: DatumThemeRegistry; active: () => number } => counted(createThemeRegistry());

describe("<datum-form-builder> registry subscriptions", () => {
  it("takes none from a registry set before the element is on the page, and one once it is", () => {
    const pluginSpy = plugins();
    const themeSpy = themes();
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.pluginRegistry = pluginSpy.registry;
    element.themes = themeSpy.registry;
    expect(pluginSpy.active()).toBe(0);
    expect(themeSpy.active()).toBe(0);
    document.body.append(element);
    expect(pluginSpy.active()).toBe(1);
    expect(themeSpy.active()).toBe(1);
  });

  it("takes none from a registry set after the element left the page", () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    document.body.append(element);
    element.remove();
    const pluginSpy = plugins();
    const themeSpy = themes();
    element.pluginRegistry = pluginSpy.registry;
    element.themes = themeSpy.registry;
    expect(pluginSpy.active()).toBe(0);
    expect(themeSpy.active()).toBe(0);
  });

  it("moves its one subscription to a registry set while on the page, and lets it go on removal", () => {
    const first = plugins();
    const second = plugins();
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.pluginRegistry = first.registry;
    document.body.append(element);
    element.pluginRegistry = second.registry;
    expect(first.active()).toBe(0);
    expect(second.active()).toBe(1);
    element.remove();
    expect(second.active()).toBe(0);
  });
});
