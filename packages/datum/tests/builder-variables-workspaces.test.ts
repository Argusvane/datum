import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/* The Variables panel fits each workspace. */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  const base = sampleDefinition();
  base.root.children!.content!.push(
    {
      id: "address",
      type: "container",
      configuration: { label: "Address", scopeData: true },
      children: { content: [{ id: "postcode", type: "text", configuration: { label: "Postcode", dataKey: "zip" } }] }
    },
    {
      id: "items",
      type: "panel",
      configuration: { label: "Items" },
      collection: { collectionPath: "items", itemFields: ["qty"] },
      children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] }
    }
  );
  return {
    ...base,
    journey: {
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "contact", title: "Contact", components: ["subscribe"] }
          ]
        }
      ],
      defaultJourneyId: "intake",
      opensAs: "form"
    }
  } as FormDefinition;
}

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = definition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const panel = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector("datum-builder-variables-panel") as HTMLElement;
const groups = (element: DatumFormBuilderElement): string[] =>
  [...panel(element).shadowRoot!.querySelectorAll<HTMLElement>("[data-variables-group]")].map((group) => group.dataset.variablesGroup!);
const refs = (element: DatumFormBuilderElement, group: string): string[] =>
  [...panel(element).shadowRoot!.querySelectorAll<HTMLElement>(`[data-variables-group="${group}"] [data-variable]`)].map((row) => row.dataset.variable!);

function openVariables(element: DatumFormBuilderElement): void {
  element.builder!.panel = "variables";
}

describe("the Variables panel per workspace", () => {
  it("keeps the rule paths and the functions in Form and Logic", async () => {
    const element = await mount();
    openVariables(element);
    // The panel's body is a chunk of its own, fetched on this first open.
    await until(() => groups(element).includes("scopes"));
    expect(groups(element)).toContain("scopes");
    expect(groups(element).some((id) => id.startsWith("functions:"))).toBe(true);
    element.builder!.setWorkspace("logic");
    openVariables(element);
    expect(groups(element)).toContain("scopes");
    expect(groups(element).some((id) => id.startsWith("functions:"))).toBe(true);
  });

  it("lists the saved value paths and data keys in Data, with no functions", async () => {
    const element = await mount();
    element.builder!.setWorkspace("data");
    openVariables(element);
    await until(() => groups(element).includes("values"));
    expect(groups(element)).toEqual(["values"]);
    const saved = refs(element, "values");
    expect(saved).toContain("fullName");
    expect(saved).toContain("address.zip");
    expect(saved).toContain("items");
    expect(saved).toContain("items[].qty");
    const text = panel(element).shadowRoot!.querySelector('[data-variable="address.zip"]')!.textContent!;
    expect(text).toContain("id postcode");
    expect(text).toContain("data key zip");
    expect(panel(element).shadowRoot!.querySelector("[data-variables-reference]")).toBeNull();
    // Back on the Form it lists the rule paths again.
    element.builder!.setWorkspace("form");
    openVariables(element);
    await until(() => groups(element).includes("scopes"));
  });

  it("lists placeholders in Print: the fields by value path, the page counters, the print words and host values, no rule functions", async () => {
    const element = await mount();
    element.builder!.setWorkspace("print");
    openVariables(element);
    await until(() => groups(element).includes("print"));
    expect(groups(element)).toEqual(["fields", "page", "print", "host"]);
    expect(refs(element, "fields")).toContain("{{address.zip}}");
    expect(refs(element, "print")).toEqual(["{{title}}", "{{date}}", "{{receipt.reference}}"]);
    expect(groups(element).some((id) => id.startsWith("functions:"))).toBe(false);
    // Back on the Form it lists the rule paths again.
    element.builder!.setWorkspace("form");
    openVariables(element);
    await until(() => groups(element).includes("scopes"));
  });

  it("adds journey paths beside the field groups in Journeys", async () => {
    const element = await mount();
    await until(() => element.journeyMode !== undefined);
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    element.builder!.selectDocument("journeys", "intake");
    await until(() => element.journeyMode!.controller.snapshot().children?.pages?.length === 2);
    openVariables(element);
    await until(() => groups(element).includes("journey:pages"));
    expect(groups(element)).toContain("fields");
    expect(refs(element, "journey:pages")).toEqual(["about", "contact", "$end"]);
    expect(groups(element).some((id) => id.startsWith("functions:"))).toBe(true);
  });
});
