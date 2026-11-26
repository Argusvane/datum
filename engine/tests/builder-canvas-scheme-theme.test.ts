// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_CANVAS_TAG, defineBuilderPanels, type DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { extendBinding, type AdapterEntry, type LiveBinding } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import { registerBinding } from "../form-engine/render/live/binding-registry.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The canvas draws the form with a design-system binding: the host's (`binding`), or
 * one the View panel's picker offers (`availableBindings`). Under a dark builder the canvas follows
 * the builder's scheme where the binding can: Datum's own binding draws its dark colour scheme, a
 * binding that names a `darkVariant` draws that binding, and one with neither draws as itself.
 * The pick (`bindingId()`) never moves with the scheme; the picker names what the canvas draws
 * (`bindingChoices()`). Nothing of it is written into the form.
 */

defineBuilderPanels();
defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

const root = (): ComponentNode =>
  ({ id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }) as ComponentNode;

const datum = createDatumBinding();
const ACME: LiveBinding = extendBinding(datum, { id: "acme", label: "Acme", darkVariant: "acme-dark" });
const ACME_DARK: LiveBinding = extendBinding(datum, { id: "acme-dark", label: "Acme dark" });
const PLAIN: LiveBinding = extendBinding(datum, { id: "plain", label: "Plain" });

const offered = [
  { id: "datum", label: "Datum" },
  { id: "acme", label: "Acme", binding: ACME },
  { id: "acme-dark", label: "Acme dark", binding: ACME_DARK },
  { id: "plain", label: "Plain", binding: PLAIN }
];

function reasons(controller: BuilderController): string[] {
  const heard: string[] = [];
  controller.on("change", (event: BuilderChangeEvent) => heard.push(event.reason));
  return heard;
}

describe("a list of bindings offered after the first paint", () => {
  it("repaints the picker with a preview change, and a list that differs in nothing does not", () => {
    const controller = new BuilderController({ initialRoot: root(), availableBindings: [offered[0]!] });
    const heard = reasons(controller);
    controller.setOptions({ availableBindings: offered });
    expect(heard).toEqual(["preview"]);
    expect(controller.bindingChoices().map((choice) => choice.id)).toEqual(["datum", "acme", "acme-dark", "plain"]);
    controller.setOptions({ availableBindings: [...offered] });
    expect(heard).toEqual(["preview"]);
  });
});

describe("the canvas's binding under the builder's scheme", () => {
  it("is the host's binding while the builder is light, Datum's when it gives none", () => {
    expect(new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: offered }).canvasBinding()).toBe(ACME);
    const plain = new BuilderController({ initialRoot: root() });
    expect(plain.canvasBinding()).toBeUndefined();
    expect(plain.canvasColorScheme()).toBe("light");
  });

  it("is the binding's dark variant while the builder is dark, and the pick stays the author's", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: offered });
    const heard = reasons(controller);
    controller.setPreviewScheme("dark");
    expect(controller.canvasBinding()).toBe(ACME_DARK);
    expect(controller.canvasColorScheme()).toBe("dark");
    expect(controller.bindingId()).toBe("acme");
    // A preview change: the canvas draws again, the tree is untouched.
    expect(heard).toEqual(["preview"]);
    controller.setPreviewScheme("light");
    expect(controller.canvasBinding()).toBe(ACME);
    expect(controller.canvasColorScheme()).toBe("light");
    expect(heard).toEqual(["preview", "preview"]);
  });

  it("draws Datum's own binding in its dark colour scheme: no other binding", () => {
    const controller = new BuilderController({ initialRoot: root() });
    const heard = reasons(controller);
    controller.setPreviewScheme("dark");
    expect(controller.canvasBinding()).toBeUndefined();
    expect(controller.canvasColorScheme()).toBe("dark");
    expect(heard).toEqual(["preview"]);
  });

  it("leaves a binding with no dark look as it is, light, and says nothing", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: PLAIN, availableBindings: offered });
    const heard = reasons(controller);
    controller.setPreviewScheme("dark");
    expect(controller.canvasBinding()).toBe(PLAIN);
    expect(controller.canvasColorScheme()).toBe("light");
    expect(heard).toEqual([]);
  });

  it("leaves a binding whose variant nobody offered or registered as it is", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: [offered[1]!] });
    controller.setPreviewScheme("dark");
    expect(controller.canvasBinding()).toBe(ACME);
    expect(controller.canvasColorScheme()).toBe("light");
  });

  it("finds a variant registered on the page when the picker does not offer it", () => {
    const night = extendBinding(datum, { id: "scheme-test-night", label: "Night" });
    registerBinding(night);
    const controller = new BuilderController({ initialRoot: root(), binding: extendBinding(datum, { id: "scheme-test-day", label: "Day", darkVariant: "scheme-test-night" }) });
    controller.setPreviewScheme("dark");
    expect(controller.canvasBinding()).toBe("scheme-test-night");
  });

  it("follows a pick made while dark, and the host setting its own binding ends the pick", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: PLAIN, availableBindings: offered });
    controller.setPreviewScheme("dark");
    controller.setBindingId("acme");
    expect(controller.canvasBinding()).toBe(ACME_DARK);
    controller.setBindingId("plain");
    expect(controller.canvasBinding()).toBe(PLAIN);
    controller.setBindingId("acme");
    controller.setOptions({ binding: "datum" });
    expect(controller.bindingId()).toBe("datum");
    expect(controller.canvasBinding()).toBeUndefined();
  });

  it("ignores an id nobody offered, and writes nothing into the form", () => {
    const controller = new BuilderController({ initialRoot: root(), availableBindings: offered });
    const before = JSON.stringify(controller.snapshot());
    const heard = reasons(controller);
    controller.setBindingId("nobody");
    expect(heard).toEqual([]);
    controller.setBindingId("acme");
    expect(controller.canvasBinding()).toBe(ACME);
    expect(JSON.stringify(controller.snapshot())).toBe(before);
    expect(heard).toEqual(["preview"]);
  });
});

/** The picker's entries as it lists them: `id=label`, the selected one starred. */
const listed = (controller: BuilderController): string[] => controller.bindingChoices().map((choice) => `${choice.selected ? "*" : ""}${choice.id}=${choice.label}`);

describe("the binding picker's entries under the builder's scheme", () => {
  it("are the offered bindings as they stand while the builder is light; Datum's entry stands for no binding", () => {
    expect(listed(new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: offered }))).toEqual(["datum=Datum", "*acme=Acme", "acme-dark=Acme dark", "plain=Plain"]);
    expect(listed(new BuilderController({ initialRoot: root(), availableBindings: offered }))[0]).toBe("*datum=Datum");
  });

  it("name a binding by its dark variant while the builder is dark, and the variant's own entry goes", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: offered });
    controller.setPreviewScheme("dark");
    expect(listed(controller)).toEqual(["datum=Datum", "*acme=Acme dark", "plain=Plain"]);
    controller.setBindingId("plain");
    expect(listed(controller)).toEqual(["datum=Datum", "acme=Acme dark", "*plain=Plain"]);
    controller.setPreviewScheme("light");
    expect(listed(controller)).toEqual(["datum=Datum", "acme=Acme", "acme-dark=Acme dark", "*plain=Plain"]);
  });

  it("stand in for a dark binding picked under the light builder with the entry that draws it", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: ACME_DARK, availableBindings: offered });
    expect(listed(controller)).toEqual(["datum=Datum", "acme=Acme", "*acme-dark=Acme dark", "plain=Plain"]);
    controller.setPreviewScheme("dark");
    expect(listed(controller)).toEqual(["datum=Datum", "*acme=Acme dark", "plain=Plain"]);
    expect(controller.bindingId()).toBe("acme-dark");
  });

  it("mark none while the canvas draws with a binding the picker does not list", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: extendBinding(datum, { id: "elsewhere", label: "Elsewhere" }), availableBindings: offered });
    expect(controller.bindingChoices().some((choice) => choice.selected)).toBe(false);
  });
});

describe("the canvas's form element", () => {
  async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error("until(): condition not met in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("draws with the controller's binding and scheme, the variant under a dark builder", () => {
    const controller = new BuilderController({ initialRoot: root(), binding: ACME, availableBindings: offered });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
    expect(renderer.binding).toBe(ACME);
    expect(renderer.colorScheme).toBe("light");

    // As the shell does: its dark tokens on the host, then the scheme to the controller.
    canvas.style.setProperty("--db-color-scheme", "dark");
    controller.setPreviewScheme("dark");
    expect(renderer.binding).toBe(ACME_DARK);
    expect(renderer.colorScheme).toBe("dark");
    // The sheet and the builder are both dark: the on-sheet chrome keeps the builder's palette.
    expect(renderer.hasAttribute("data-sheet-scheme")).toBe(false);

    canvas.style.removeProperty("--db-color-scheme");
    controller.setPreviewScheme("light");
    expect(renderer.binding).toBe(ACME);
    expect(renderer.colorScheme).toBe("light");
  });

  it("lays a tree's own types over the binding, as one object while nothing changes", () => {
    const page = { kind: "field" as const, name: "page face", template: () => undefined } as unknown as AdapterEntry;
    const controller = new BuilderController({ initialRoot: root(), canvasComponents: { page } });
    const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
    canvas.controller = controller;
    document.body.append(canvas);
    const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
    const drawn = renderer.binding as LiveBinding;
    expect(drawn.id).toBe("datum");
    expect(drawn.components.page).toBe(page);
    controller.setPreviewWidth(600);
    expect(renderer.binding).toBe(drawn);
  });

  it("draws the form element's alert in the canvas's place when a design system's stylesheet cannot be fetched", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    try {
      const controller = new BuilderController({ initialRoot: root(), binding: PLAIN, assets: { stylesheets: [{ url: "https://ds.example/ds.css" }] } });
      const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
      canvas.controller = controller;
      document.body.append(canvas);
      const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
      expect(renderer.assets).toBe(controller.canvasAssets());
      await until(() => renderer.shadowRoot?.querySelector('[role="alert"]'));
      expect(renderer.shadowRoot!.querySelector("[data-component-id]")).toBeNull();
      expect(renderer.shadowRoot!.querySelector("form")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // One design system's files never style another's canvas.
  it("draws a picked binding with that entry's files, never the host's, and Datum with none", async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = ((url: string) => {
      fetched.push(String(url));
      return Promise.reject(new TypeError("Failed to fetch"));
    }) as typeof fetch;
    try {
      const host = { stylesheets: [{ url: "https://ds.example/plain.css" }] };
      const acme = { stylesheets: [{ url: "https://ds.example/acme.css" }] };
      const controller = new BuilderController({
        initialRoot: root(),
        binding: PLAIN,
        assets: host,
        availableBindings: [{ id: "datum", label: "Datum" }, { id: "plain", label: "Plain", binding: PLAIN }, { id: "acme", label: "Acme", binding: ACME, assets: acme }]
      });
      expect(controller.canvasAssets()).toBe(host);
      const canvas = document.createElement(DATUM_BUILDER_CANVAS_TAG) as DatumBuilderCanvasElement;
      canvas.controller = controller;
      document.body.append(canvas);
      const renderer = canvas.shadowRoot!.querySelector("[data-preview]") as DatumFormRendererElement;
      await until(() => renderer.shadowRoot?.querySelector('[role="alert"]'));
      controller.setBindingId("datum");
      expect(controller.canvasAssets()).toBeUndefined();
      expect(renderer.assets).toBeUndefined();
      // Datum's form draws: no host stylesheet is fetched for it.
      const before = fetched.length;
      await until(() => renderer.shadowRoot?.querySelector('[data-component-id="name"]'));
      expect(renderer.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
      expect(fetched.length).toBe(before);
      controller.setBindingId("acme");
      expect(controller.canvasAssets()).toBe(acme);
      controller.setBindingId("plain");
      expect(controller.canvasAssets()).toBe(host);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the View panel's picker in a dark builder", () => {
  async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeoutMs) {
        throw new Error("until(): condition not met in time");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("names the binding the canvas draws, and a choice made there is the light binding's", async () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: root(), componentTypes: [{ type: "text", label: "Text" }], binding: ACME, availableBindings: offered };
    document.body.append(element);
    const picker = element.shadowRoot!.querySelector<HTMLSelectElement>("[data-binding]")!;
    const field = element.shadowRoot!.querySelector<HTMLElement>("[data-binding-field]")!;
    await until(() => picker.value === "acme");
    expect(field.hidden).toBe(false);
    expect(picker.selectedOptions[0]!.textContent).toBe("Acme");

    element.setAttribute("scheme", "dark");
    await until(() => picker.selectedOptions[0]?.textContent === "Acme dark");
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Datum", "Acme dark", "Plain"]);
    expect(field.title).toContain("Acme dark");
    expect(element.activeController.bindingId()).toBe("acme");

    const heard: string[] = [];
    element.addEventListener("builder-binding-change", (event) => heard.push((event as CustomEvent<{ bindingId: string }>).detail.bindingId));
    picker.value = "plain";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    picker.value = "acme";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    // The host hears the binding, never its variant: the scheme is the builder's own.
    expect(heard).toEqual(["plain", "acme"]);
    expect(element.activeController.canvasBinding()).toBe(ACME_DARK);

    element.setAttribute("scheme", "light");
    await until(() => picker.selectedOptions[0]?.textContent === "Acme");
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Datum", "Acme", "Acme dark", "Plain"]);
  });

  it("is away with one entry or none, and without the binding-picker feature", async () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: root(), componentTypes: [{ type: "text", label: "Text" }], availableBindings: [offered[0]!] };
    document.body.append(element);
    const field = element.shadowRoot!.querySelector<HTMLElement>("[data-binding-field]")!;
    await until(() => element.shadowRoot!.querySelector("[data-binding] option"));
    expect(field.hidden).toBe(true);
  });
});
