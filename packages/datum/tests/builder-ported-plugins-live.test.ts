import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement, FormDefinition } from "../src/builder.js";

import { ACME_LINK_TYPE, ACME_PALETTE_GROUP, acmeComponentsPlugin } from "./fixtures/acme-components.js";
import { sampleDefinition, until } from "./helpers.js";

/*
 * A live builder follows what the page wires into it: a plugin taken away drops its palette
 * entries and leaves the form it helped author, and a data source the page wires is the one the
 * canvas draws a picked select from.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function builderReady(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

const canvasRenderer = (element: DatumFormBuilderElement): ShadowRoot | null | undefined =>
  element.builder!.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("datum-form-renderer")?.shadowRoot;

describe("<datum-form-builder> when a plugin is removed from a live builder", () => {
  it("drops the plugin's palette entries, and the tree and the canvas stay", async () => {
    // The unknown-type note the canvas draws once the type has no definition warns once; not under test here.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = sampleDefinition();
    const definition: FormDefinition = {
      ...base,
      root: { ...base.root, children: { content: [...base.root.children!.content!, { id: "card", type: ACME_LINK_TYPE, configuration: { text: "Welcome", href: "/welcome" } }] } }
    };
    const element = document.createElement("datum-form-builder");
    element.plugins = [acmeComponentsPlugin];
    element.definition = definition;
    document.body.append(element);
    await builderReady(element);

    const types = (): Array<{ type: string; group?: string | undefined }> => element.controller!.componentTypes();
    expect(types().filter((entry) => entry.group === ACME_PALETTE_GROUP)).toHaveLength(3);
    await until(() => canvasRenderer(element)?.querySelector('.db-node[data-component-id="card"] .acme-link'));
    // Assigning `plugins` reseeds the builder from the form it was given, so the tree to outlive the plugin is that one.
    const placed = element.definition.root.children!.content!.map((child) => child.id);
    expect(placed).toEqual(["fullName", "country", "subscribe", "email", "submit", "card"]);

    element.plugins = [];
    await until(() => !types().some((entry) => entry.type === ACME_LINK_TYPE));
    expect(types().filter((entry) => entry.group === ACME_PALETTE_GROUP)).toEqual([]);
    // The standard catalogue is always there.
    expect(types().some((entry) => entry.type === "text")).toBe(true);

    // The tree survives the catalogue change, the authored node of the removed type included.
    expect(element.definition.root.children!.content!.map((child) => child.id)).toEqual(placed);
    expect(element.definition.root.children!.content!.find((child) => child.id === "card")?.type).toBe(ACME_LINK_TYPE);
    // And the canvas still draws it, as a node that can be selected, in the plugin's absence.
    await until(() => canvasRenderer(element)?.querySelector('.db-node[data-component-id="card"] [role="note"]'));
    expect(canvasRenderer(element)?.querySelector('.db-node[data-component-id="card"] .acme-link')).toBeNull();
    expect(canvasRenderer(element)?.textContent).toContain("Full name");
  });
});

describe("<datum-form-builder> with the page's data sources", () => {
  it("draws the picked select from a wired source on the canvas, the picker listing the wired ids", async () => {
    const element = document.createElement("datum-form-builder");
    element.dataSources = {
      countries: [{ value: "CA", label: "Canada" }],
      provinces: [
        { value: "ON", label: "Ontario" },
        { value: "QC", label: "Quebec" }
      ]
    };
    element.definition = sampleDefinition();
    document.body.append(element);
    await builderReady(element);
    const options = (): string[] =>
      Array.from(canvasRenderer(element)?.querySelectorAll<HTMLOptionElement>('[data-component-id="country"] select option') ?? []).map((option) => option.textContent ?? "");
    await until(() => options().includes("Canada"));
    expect(options()).not.toContain("Ontario");

    element.controller!.select("country");
    const properties = element.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
    await until(() => properties.querySelector('select[data-prop="data.sourceId"]'));
    const picker = (): HTMLSelectElement => properties.querySelector<HTMLSelectElement>('select[data-prop="data.sourceId"]')!;
    // The wired sources are what the picker offers, the form's current one selected.
    expect(Array.from(picker().options).map((option) => option.value)).toEqual(expect.arrayContaining(["countries", "provinces"]));
    expect(picker().value).toBe("countries");

    picker().value = "provinces";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    properties.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();

    // The canvas draws the wired source the select now names.
    await until(() => options().includes("Ontario"));
    expect(options()).toEqual(expect.arrayContaining(["Ontario", "Quebec"]));
    expect(options()).not.toContain("Canada");
    expect((element.definition.root.children!.content!.find((child) => child.id === "country")!.configuration as { data: { sourceId: string } }).data.sourceId).toBe("provinces");
  });
});
