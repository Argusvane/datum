import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { bindings, type LiveBinding } from "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/*
 * The builder's canvas draws the form with a design-system binding: `binding` names
 * one (an object, or the id of one registered with `bindings.register`), the picker offers every
 * registered binding beside Datum's.
 */
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const named = (id: string): LiveBinding => ({ id, label: `Label ${id}`, components: {} });

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  return element;
}

async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

describe("<datum-form-builder> binding", () => {
  it("offers Datum's binding and every registered one on the picker, and follows later registrations", async () => {
    bindings.register(named("wc-builder-a"));
    const element = mount();
    await ready(element);
    const ids = () => element.controller!.availableBindings().map((option) => option.id);
    expect(ids()).toEqual(expect.arrayContaining(["datum", "wc-builder-a"]));
    expect(element.controller!.availableBindings().find((option) => option.id === "wc-builder-a")?.label).toBe("Label wc-builder-a");
    bindings.register(named("wc-builder-late"));
    await until(() => ids().includes("wc-builder-late"));
  });

  it("draws the canvas with the binding it names, by object or by registered id, and tells the host which is picked", async () => {
    const own = named("wc-builder-own");
    bindings.register([own, named("wc-builder-by-id")]);
    const element = mount((el) => {
      el.binding = own;
    });
    await ready(element);
    await until(() => element.controller!.bindingId() === "wc-builder-own");
    expect(element.controller!.canvasBinding()).toBe(own);

    element.binding = "wc-builder-by-id";
    await until(() => element.controller!.bindingId() === "wc-builder-by-id");

    const heard: Array<{ bindingId: string }> = [];
    element.addEventListener("datum-builder-binding-change", (event) => heard.push((event as CustomEvent<{ bindingId: string }>).detail));
    expect(element.builder!.setBindingForAgent("wc-builder-own")).toBe(true);
    expect(heard.at(-1)?.bindingId).toBe("wc-builder-own");
  });
});
