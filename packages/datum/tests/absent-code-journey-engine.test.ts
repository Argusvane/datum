import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The journeys runtime chunk as a missing file, with
 * the REAL loader and element wired together: only the chunk's module is made to fail, the way a
 * dynamic import of a deleted or blocked file fails. The element's own states with a mocked loader
 * (queueing, supersession, Retry bookkeeping) are form-element-journey-lazy.test.ts; the loader's
 * own contract is journey-engine-loader.test.ts; this file pins what only the two together show:
 *
 * - a chunk that fails to import leaves the card (role=alert, Retry) worded by the engine's default
 *   `journeysUnavailable` / `retry` texts, one `datum-error` whose cause is the ChunkLoadError's
 *   cause, the renderer hidden (never the form as one page), and no unhandled rejection;
 * - Retry asks the import again (the failure was not remembered) and, once it succeeds, the form
 *   is ready and draws its first page;
 * - a plain form and a form whose `features` leave journeys out never import the chunk;
 * - the debug diagnostics module that links itself to the chunk (so the renderer has one journey
 *   file) still answers what the engine's diagnostics answer.
 */

const chunk = vi.hoisted(() => ({ failure: undefined as unknown, imports: 0 }));
vi.mock("../src/journey-engine-chunk.js", async (importActual) => {
  chunk.imports += 1;
  if (chunk.failure !== undefined) {
    throw chunk.failure;
  }
  return importActual();
});

import "../src/form.js";
import type { DatumErrorDetail, DatumFormElement, DatumFormReadyDetail } from "../src/form.js";
import { DEFAULT_FORM_TEXTS, diagnoseJourneys as engineDiagnose, type FormDefinition } from "@argusvane/datum-engine";

import { journeyTitleOf, until } from "./helpers.js";

function journeyForm(): FormDefinition {
  return {
    id: "absent",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Absent" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "email", type: "text", configuration: { label: "Email" } }
        ]
      }
    },
    journey: {
      journeys: [
        {
          id: "apply",
          pages: [
            { id: "first", title: "First page", components: ["name"] },
            { id: "second", title: "Second page", components: ["email"] }
          ]
        }
      ]
    }
  };
}

function plainForm(): FormDefinition {
  const { journey: _journey, ...plain } = journeyForm();
  return plain as FormDefinition;
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

const card = (element: DatumFormElement): HTMLElement | null => element.shadowRoot!.querySelector<HTMLElement>("[data-journeys-error]");
const heading = (element: DatumFormElement): string | undefined => journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  chunk.failure = undefined;
  chunk.imports = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<datum-form> when the journeys runtime chunk cannot be imported", () => {
  // Order matters: once a Retry has loaded the chunk it stays on the page (module state), so the tests that need it missing come first.
  it("words the card from the page's texts when it gives them", async () => {
    const element = document.createElement("datum-form");
    element.definition = journeyForm();
    element.texts = { journeysUnavailable: "Le formulaire n'a pas pu se charger.", retry: "Réessayer" };
    chunk.failure = new TypeError("Failed to fetch dynamically imported module");
    document.body.append(element);
    await until(() => card(element));
    expect(card(element)!.textContent).toContain("Le formulaire n'a pas pu se charger.");
    expect(card(element)!.querySelector("button")!.textContent).toBe("Réessayer");
  });

  it("leaves the card, one datum-error with the browser's error as cause, a hidden renderer, and nothing unhandled; Retry then builds the form", async () => {
    const element = document.createElement("datum-form");
    element.definition = journeyForm();
    // The browser's own error, as the loader receives it (vitest wraps a mock factory's throw, so the
    // cause is the wrapper: what is pinned is that it is an Error and that the message carries it).
    chunk.failure = new TypeError("Failed to fetch dynamically imported module: /datum-form-journey-engine-chunk-abc.js");
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);

    await until(() => card(element));
    const shown = card(element)!;
    expect(shown.getAttribute("role")).toBe("alert");
    // The engine's default wording, with no `texts` from the page.
    expect(shown.textContent).toContain(DEFAULT_FORM_TEXTS.journeysUnavailable);
    const retry = shown.querySelector<HTMLButtonElement>("button[data-journeys-retry]")!;
    expect(retry.textContent).toBe(DEFAULT_FORM_TEXTS.retry);
    expect(element.renderer!.hidden).toBe(true);
    expect(element.runtime).toBeUndefined();
    expect(ready).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("The journeys runtime");
    expect(errors[0]!.cause).toBeInstanceOf(Error);
    expect(errors[0]!.message).toContain((errors[0]!.cause as Error).message);
    // Calls made now reject with a clear error, and say what is missing.
    await expect(element.submit()).rejects.toThrow(/journeys runtime/);
    await expect(element.nextPage()).rejects.toThrow(/journeys runtime/);

    // The file is back: Retry asks for the import again (a failure is not remembered).
    chunk.failure = undefined;
    const before = chunk.imports;
    retry.click();
    await until(() => ready.length === 1);
    expect(chunk.imports).toBeGreaterThan(before);
    expect(card(element)).toBeNull();
    expect(element.renderer!.hidden).toBe(false);
    await until(() => heading(element) === "First page");
    expect(errors).toHaveLength(1);

    await Promise.resolve();
    expect(unhandled).toEqual([]);
  });
});

describe("<datum-form> never imports the journeys runtime chunk it does not need", () => {
  it("a plain form is ready and does not import it", async () => {
    chunk.failure = new TypeError("must not be asked for");
    const element = document.createElement("datum-form");
    element.definition = plainForm();
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await element.ready;
    expect(ready).toHaveLength(1);
    expect(chunk.imports).toBe(0);
    expect(card(element)).toBeNull();
  });

  it("a journey form whose features leave journeys out is one page and does not import it", async () => {
    chunk.failure = new TypeError("must not be asked for");
    const element = document.createElement("datum-form");
    element.setAttribute("features", "print");
    element.setAttribute("journey", "apply");
    element.definition = journeyForm();
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await element.ready;
    expect(ready).toHaveLength(1);
    expect(chunk.imports).toBe(0);
    expect(errors).toHaveLength(0);
    expect(card(element)).toBeNull();
    expect(element.renderer!.hidden).toBe(false);
  });
});

describe("the journey diagnostics module that links itself to the chunk (one journey file in the renderer)", () => {
  it("answers what the engine's diagnostics answer", async () => {
    const { diagnoseJourneys } = await import("../src/journey-diagnostics.js");
    const definition = journeyForm();
    expect(diagnoseJourneys(definition)).toEqual(engineDiagnose(definition));
    // Its options go through too.
    expect(diagnoseJourneys(definition, {})).toEqual(engineDiagnose(definition, {}));
  });
});
