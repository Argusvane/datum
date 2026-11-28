import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { modesReady, until } from "./helpers.js";

/*
 * "Valid when" on the form's Rules tab, which keeps Off | Formula; and a journey
 * route's Rules tab, which is gone: a route's condition is edited in
 * the Logic workspace's Go to rule, written as a formula, so the Simple mode it had has
 * no place left. Go to rules in Logic are held by builder-logic.test.ts.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(when?: unknown): FormDefinition {
  return JSON.parse(
    JSON.stringify({
      id: "simple-conditions",
      version: "1.0.0",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Conditions" },
        children: {
          content: [
            {
              id: "contact",
              type: "radio",
              configuration: {
                label: "Contact method",
                options: [
                  { value: "mail", label: "Mail" },
                  { value: "phone", label: "Phone" },
                  { value: "email", label: "Email" }
                ]
              }
            },
            { id: "age", type: "number", configuration: { label: "Age" } },
            { id: "agree", type: "checkbox", configuration: { label: "Agree" } },
            { id: "fullName", type: "text", configuration: { label: "Full name" } },
            { id: "address", type: "text", configuration: { label: "Address" } },
            { id: "notes", type: "html", configuration: { tag: "div", content: "<p>Notes</p>" } },
            { id: "submit", type: "button", configuration: { label: "Send", action: "submit" } }
          ]
        }
      },
      journey: {
        journeys: [
          {
            id: "main",
            name: "Main",
            pages: [
              { id: "first", title: "First", components: ["contact", "age", "agree", "fullName"], routes: [{ to: "second", ...(when !== undefined ? { when } : {}) }] },
              { id: "second", title: "Second", components: ["address"] }
            ]
          }
        ]
      }
    })
  ) as FormDefinition;
}

async function mount(form: FormDefinition): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("features", "-pdf");
  element.definition = form;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const propertiesEl = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector("datum-builder-properties") as HTMLElement;
const properties = (element: DatumFormBuilderElement): ShadowRoot => propertiesEl(element).shadowRoot!;

function sheet(element: DatumFormBuilderElement): ShadowRoot | undefined {
  const canvas = shell(element).querySelector("datum-builder-canvas") as (HTMLElement & { previewRoot(): ShadowRoot | undefined }) | null;
  return canvas?.previewRoot();
}

async function openRoute(element: DatumFormBuilderElement): Promise<string> {
  element.mode = "journeys";
  // The journey opens on its map: the route is selected through its controller, which needs no cards.
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
  const controller = element.journeyMode!.controller;
  const routeId = controller.snapshot().children!.pages![0]!.children!.routes![0]!.id;
  controller.select(routeId);
  await until(() => properties(element).querySelector("[data-inspector-tab]"));
  return routeId;
}

describe("a journey route has no Rules tab", () => {
  it("shows its properties but no Rules tab, whatever it holds, and no rule sections", async () => {
    for (const when of [undefined, 'contact = "mail"']) {
      const element = await mount(definition(when));
      await openRoute(element);
      const tabs = [...properties(element).querySelectorAll<HTMLElement>("[data-inspector-tab]")].map((tab) => tab.dataset.inspectorTab);
      expect(tabs).not.toContain("rules");
      expect(properties(element).querySelector("[data-rule-section]")).toBeNull();
      document.body.innerHTML = "";
    }
    // Two builders, each drawing its journey's map as it opens: slower than the cards were.
  }, 60_000);

  it("keeps the condition the route holds as it was: the inspector writes nothing when it is only looked at", async () => {
    const element = await mount(definition('contact = "mail"'));
    await openRoute(element);
    expect(element.journeyMode!.journey!.pages[0]!.routes).toEqual([{ when: 'contact = "mail"', to: "second" }]);
  });
});

