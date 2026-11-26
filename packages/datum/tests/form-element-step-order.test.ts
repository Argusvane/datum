import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { until } from "./helpers.js";
import { control, type } from "./live-dom.js";

/**
 * Datum's `stepProgress: "beforeList"` and `actionOrder: "nextFirst"` controls in a live form:
 * moving through the steps still works, focus still lands on the new step's heading, and an
 * invalid Continue still moves focus to the error summary when the binding asks for it.
 */
afterEach(() => {
  document.body.innerHTML = "";
});

const BINDING = createDatumBinding({ controls: { stepProgress: "beforeList", actionOrder: "nextFirst", errorFocus: "summary" } });

function definition(): FormDefinition {
  return {
    id: "order-form",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Apply" },
      children: {
        content: [
          {
            id: "flow",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
                { id: "where", type: "step", configuration: { label: "Where you live" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } },
                { id: "review", type: "step", configuration: { label: "Review" }, children: { content: [{ id: "send", type: "button", configuration: { label: "Send", action: "submit" } }] } }
              ]
            }
          }
        ]
      }
    }
  };
}

const before = (first: Element, second: Element): boolean => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("<datum-form> with the step-order controls", () => {
  it("draws the progress line first and Continue before Back, and every step change still works", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.binding = BINDING;
    element.definition = definition();
    document.body.append(element);
    await until(() => element.renderer?.shadowRoot?.querySelector("[data-step-container]"));
    const form = element.renderer!.shadowRoot!;
    const progress = (): Element => [...form.querySelectorAll('[aria-live="polite"]')].find((region) => /Step \d+ of 3/.test(region.textContent ?? ""))!;
    const list = (): Element => form.querySelector("[data-step-status]")!;
    expect(before(progress(), list())).toBe(true);

    // An invalid Continue holds the step and moves focus to the error summary.
    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => form.querySelector("[data-datum-summary]")?.contains(form.activeElement) === true);

    type(control(form, "name"), "Ada");
    await until(() => element.runtime?.state().values.name === "Ada");
    form.querySelector<HTMLElement>("[data-step-next]")!.click();
    await until(() => form.querySelector("[data-step-container]")?.getAttribute("data-step-active") === "where");
    await until(() => form.activeElement?.tagName === "H2" || /^H[1-6]$/.test(form.activeElement?.tagName ?? ""));
    expect(form.activeElement?.textContent).toBe("Step 2 of 3: Where you live");
    expect(progress().textContent).toContain("Step 2 of 3");
    // The actions repaint in the same order: Continue first, then Back.
    expect(before(form.querySelector("[data-step-next]")!, form.querySelector("[data-step-prev]")!)).toBe(true);

    form.querySelector<HTMLElement>("[data-step-prev]")!.click();
    await until(() => form.querySelector("[data-step-container]")?.getAttribute("data-step-active") === "about");
    await until(() => /^H[1-6]$/.test(form.activeElement?.tagName ?? ""));
    expect(form.activeElement?.textContent).toBe("Step 1 of 3: About you");
  });
});
