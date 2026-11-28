import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement, JourneyValidationRequest } from "../src/form.js";
import type { FormDefinition, Journey } from "@argusvane/datum-engine";

import { journeyTitleOf, until } from "./helpers.js";

/*
 * The server validator is a lazy chunk: `validate-url` asks for it when the URL is
 * applied, once per page; a form without the attribute, or with a validator of its own, never
 * does. The chunk's module is replaced by a counting stand-in around the real one, so each
 * import of the chunk is seen. Tests run in order on purpose: the page's one load is shared
 * across the file, so "never requested" is asserted before the first element that asks.
 */
const chunk = vi.hoisted(() => ({ imports: 0 }));
vi.mock("../src/server-validator.js", async (importActual) => {
  chunk.imports += 1;
  return importActual();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const eq = (name: string, value: string): string => `${name} = "${value}"`;

function checkedJourney(): Journey {
  return {
    id: "apply",
    pages: [
      { id: "about", title: "About you", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "overseas" }, { to: "contact" }] },
      { id: "overseas", title: "Where you live abroad", components: ["country"], validation: { continue: "page", server: true } },
      { id: "contact", title: "How to reach you", components: ["email"] }
    ]
  };
}

function definition(): FormDefinition {
  return {
    id: "eligibility",
    version: "3.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Permit application" },
      children: {
        content: [
          {
            id: "resident",
            type: "radio",
            configuration: {
              label: "Do you live in Canada?",
              required: true,
              options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" }
              ]
            }
          },
          { id: "country", type: "text", configuration: { label: "Country", required: true } },
          { id: "email", type: "text", configuration: { label: "Email", required: true } }
        ]
      }
    },
    journey: { journeys: [checkedJourney()] }
  };
}

function mount(setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  document.body.append(element);
  return element;
}

function heading(element: DatumFormElement): string | undefined {
  return journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
}

async function atOverseas(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => heading(element) === "About you");
  element.runtime!.setValue("resident", "no");
  expect((await element.nextPage()).pageId).toBe("overseas");
  element.runtime!.setValue("country", "Atlantis");
  await until(() => heading(element) === "Where you live abroad");
  return element.renderer!.shadowRoot!;
}

describe("the server validator chunk", () => {
  it("is never requested by a form with no validate-url and no validator", async () => {
    const element = mount((el) => {
      el.definition = definition();
    });
    await atOverseas(element);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunk.imports).toBe(0);
  });

  it("is never requested when the page hands the element a serverValidator of its own", async () => {
    const seen: JourneyValidationRequest[] = [];
    const element = mount((el) => {
      el.serverValidator = async (request) => {
        seen.push(request);
        return { errors: [] };
      };
      el.definition = definition();
    });
    const root = await atOverseas(element);
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => heading(element) === "How to reach you");
    expect(seen).toHaveLength(1);
    expect(chunk.imports).toBe(0);
  });

  it("is requested once when validate-url is applied, however many elements and checks follow", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const first = mount((el) => {
      el.setAttribute("validate-url", "/api/journey-check");
      el.definition = definition();
    });
    // Asked for as the attribute is applied, before any check is made.
    await until(() => chunk.imports === 1);
    const root = await atOverseas(first);
    expect(fetchMock).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => heading(first) === "How to reach you");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The chunk posts the delivery a Datum host takes.
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ scope: "page", pageId: "overseas", document: { submission: { values: { country: "Atlantis" } } } });

    const second = mount((el) => {
      el.setAttribute("validate-url", "/api/other-check");
      el.definition = definition();
    });
    await atOverseas(second);
    second.renderer!.shadowRoot!.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => heading(second) === "How to reach you");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunk.imports).toBe(1);
  });
});
