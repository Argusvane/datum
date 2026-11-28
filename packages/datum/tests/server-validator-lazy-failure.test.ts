import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumErrorDetail } from "../src/form.js";

import { journeyTitleOf, until } from "./helpers.js";

/*
 * A server validator chunk that fails to load fails the check closed: the
 * runtime reads a validator that rejects with no verdict as the server being unavailable, and
 * the journey's `onUnavailable` is "block" unless the form says otherwise, so the person stays
 * on the page and is told the answers could not be checked. The next check asks for the chunk
 * again, and passes once it arrives.
 */
const chunk = vi.hoisted(() => ({ imports: 0, failures: 1 }));
vi.mock("../src/server-validator.js", async (importActual) => {
  chunk.imports += 1;
  if (chunk.failures > 0) {
    chunk.failures -= 1;
    throw new Error("chunk 404");
  }
  return importActual();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const eq = (name: string, value: string): string => `${name} = "${value}"`;

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
          { id: "resident", type: "text", configuration: { label: "Resident", required: true } },
          { id: "country", type: "text", configuration: { label: "Country", required: true } },
          { id: "email", type: "text", configuration: { label: "Email", required: true } }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "apply",
          validation: { end: "server" },
          pages: [
            { id: "about", title: "About you", components: ["resident"], routes: [{ when: eq("resident", "no"), to: "overseas" }, { to: "contact" }] },
            { id: "overseas", title: "Where you live abroad", components: ["country"], validation: { continue: "page", server: true } },
            { id: "contact", title: "How to reach you", components: ["email"] }
          ]
        }
      ]
    }
  };
}

function heading(element: DatumFormElement): string | undefined {
  return journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
}

describe("a server validator chunk that fails to load", () => {
  it("blocks the page check while the chunk is missing, and passes once it arrives", async () => {
    chunk.failures = 2;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const element = document.createElement("datum-form") as DatumFormElement;
    element.setAttribute("validate-url", "/api/journey-check");
    element.definition = definition();
    const errors: DatumErrorDetail[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<DatumErrorDetail>).detail));
    document.body.append(element);
    await until(() => heading(element) === "About you");
    // The preload failed quietly (nothing unhandled, nothing reported); the check is what answers for it.
    await until(() => chunk.imports === 1);
    // The page hears of the missing file as datum-error, naming it, with the browser's error as cause.
    await until(() => errors.length > 0);
    expect(errors[0]!.message).toContain("datum-form-server-validator-*.js");
    expect(errors[0]!.cause).toBeInstanceOf(Error);

    element.runtime!.setValue("resident", "no");
    await element.nextPage();
    element.runtime!.setValue("country", "Atlantis");
    await until(() => heading(element) === "Where you live abroad");
    const root = element.renderer!.shadowRoot!;
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    // The failure was forgotten, so the check asks again, fails again, and the person stays put, told.
    await until(() => chunk.imports === 2);
    await until(() => (root.querySelector("[data-datum-summary] [role=alert]")?.textContent ?? "").includes("We could not check your answers. Try again."));
    expect(heading(element)).toBe("Where you live abroad");
    expect(fetchMock).not.toHaveBeenCalled();

    // The third load succeeds: the same check now reaches the service and the journey goes on.
    root.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => heading(element) === "How to reach you");
    expect(chunk.imports).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
