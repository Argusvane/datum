import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import { bindings, composeDatumOptions, createDatumBinding, type DatumFormElement, type LiveBinding } from "../src/form.js";

import { sampleDefinition, until } from "./helpers.js";

/*
 * The element is drawn by a design-system binding: `binding` names one (an object or
 * the id of one registered with `bindings.register`), and `assets` and `colorScheme` ride along.
 */
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const named = (id: string): LiveBinding => ({ id, label: id, components: {} });

function mount(configure: (element: DatumFormElement) => void = () => undefined): DatumFormElement {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.definition = sampleDefinition();
  configure(element);
  document.body.append(element);
  return element;
}

async function drawn(element: DatumFormElement): Promise<void> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
}

describe("bindings.fromFactory", () => {
  it("calls a binding package's factory with the page's lit and Datum's binding, and gives back what it returned", () => {
    let seen: { lit: unknown; datum: LiveBinding } | undefined;
    const made = bindings.fromFactory((lit, datum) => {
      seen = { lit, datum };
      return { id: "wc-from-factory", label: "From a factory", components: { text: datum.components["text"]! } };
    });
    expect(made.id).toBe("wc-from-factory");
    expect(typeof (seen!.lit as { html: unknown }).html).toBe("function");
    expect(seen!.datum.id).toBe("datum");
    expect(Object.keys(seen!.datum.components)).toEqual(expect.arrayContaining(["text", "radio", "date"]));
    // Datum's binding is one per page: a second factory is handed the same object.
    let again: LiveBinding | undefined;
    bindings.fromFactory((_lit, datum) => {
      again = datum;
      return made;
    });
    expect(again).toBe(seen!.datum);
    // What it made registers like any binding.
    bindings.register(made);
    expect(bindings.get("wc-from-factory")).toBe(made);
  });
});

describe("bindings.register", () => {
  it("registers, replaces by id, lists, and refuses the Datum binding's id", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = named("wc-registry-a");
    bindings.register(first);
    expect(bindings.get("wc-registry-a")).toBe(first);
    const second = named("wc-registry-a");
    bindings.register([second, named("wc-registry-b")]);
    expect(bindings.get("wc-registry-a")).toBe(second);
    expect(bindings.list().map((binding) => binding.id)).toEqual(expect.arrayContaining(["wc-registry-a", "wc-registry-b"]));
    bindings.register(named("datum"));
    expect(bindings.get("datum")).toBeUndefined();
  });

  it("tells a subscriber when a binding is registered", () => {
    const heard = vi.fn();
    const stop = bindings.subscribe(heard);
    bindings.register(named("wc-registry-heard"));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    bindings.register(named("wc-registry-heard-later"));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("<datum-form> binding", () => {
  it("draws with Datum's binding when none is named", async () => {
    const element = mount();
    await drawn(element);
    expect(element.renderer!.drawnBinding.id).toBe("datum");
  });

  it("draws with a binding given as an object, and forwards assets and colorScheme", async () => {
    const own = named("wc-object");
    const assets = { stylesheets: [] } as never;
    const element = mount((el) => {
      el.binding = own;
      el.assets = assets;
      el.colorScheme = "dark";
    });
    await drawn(element);
    expect(element.binding).toBe(own);
    expect(element.renderer!.binding).toBe(own);
    expect(element.renderer!.drawnBinding).toBe(own);
    expect(element.renderer!.assets).toBe(assets);
    expect(element.renderer!.colorScheme).toBe("dark");
    element.colorScheme = "light";
    await until(() => element.renderer!.colorScheme === "light");
  });

  it("draws with a registered id, and with the one registered after the element named it", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registered = named("wc-by-id");
    bindings.register(registered);
    const element = mount((el) => {
      el.binding = "wc-by-id";
    });
    await drawn(element);
    expect(element.renderer!.drawnBinding).toBe(registered);

    const late = mount((el) => {
      el.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent).detail));
      el.binding = "wc-not-yet";
    });
    await drawn(late);
    // Reported once as datum-binding-error, and Datum's binding draws meanwhile.
    expect(errors).toEqual([expect.objectContaining({ hook: "binding", id: "wc-not-yet" })]);
    expect(late.renderer!.drawnBinding.id).toBe("datum");
    const arrived = named("wc-not-yet");
    bindings.register(arrived);
    await until(() => late.renderer!.drawnBinding === arrived);
  });

  it("draws with a restyled Datum binding made from the bundle's createDatumBinding", async () => {
    const options = composeDatumOptions({ id: "wc-acme", label: "Acme", tokens: { "color-accent": "#00539b" } }, { formClass: "acme-form" });
    const acme = createDatumBinding(options);
    expect(acme.id).toBe("wc-acme");
    expect(String(acme.css)).toContain("#00539b");
    const element = mount((el) => {
      el.binding = acme;
    });
    await drawn(element);
    expect(element.renderer!.drawnBinding).toBe(acme);
    // Registered under its own id, it is named like any other binding.
    bindings.register(acme);
    expect(bindings.get("wc-acme")).toBe(acme);
  });
});
