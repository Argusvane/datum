import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Check answers chunk (`datum-form-journey-review-chunk-*.js`, src/journey-review-chunk.ts)
 * with the REAL loaders and element: a journey with a page of kind `review` starts the fetch of it
 * and of the journeys chunk at once (not one after the
 * other; tests/journey-review-parallel.test.ts holds the journeys chunk back to prove it) and waits for both before its first draw; a journey without one, and a form whose
 * `features` leave journeys out, never import it; a chunk that fails to import is reported the way
 * the journeys chunk's failure is (the card with Retry, one `datum-error`, no form drawn), and Retry
 * builds the form with its list. Only the review chunk's module is made to fail.
 */

const chunks = vi.hoisted(() => ({ reviewFailure: undefined as unknown, reviewImports: 0, reviewReads: 0, engineImports: 0 }));
vi.mock("../src/journey-review-chunk.js", async (importActual) => {
  chunks.reviewImports += 1;
  if (chunks.reviewFailure !== undefined) {
    throw chunks.reviewFailure;
  }
  const actual = await importActual<typeof import("../src/journey-review-chunk.js")>();
  // The factory runs once per instantiation of the module, so it cannot count a load of the
  // module already in place; every load the loader makes reads the bundle off it, and that is
  // counted (`reviewReads`) however the module came.
  return {
    ...actual,
    get journeyReviewBundle() {
      chunks.reviewReads += 1;
      return actual.journeyReviewBundle;
    }
  };
});
vi.mock("../src/journey-engine-chunk.js", async (importActual) => {
  chunks.engineImports += 1;
  return importActual();
});

import "../src/form.js";
import type { DatumErrorDetail, DatumFormElement, DatumFormReadyDetail } from "../src/form.js";
import { EagerJourneyRenderKit, createJourneyRenderKit, type FormDefinition, type JourneyPage } from "@argusvane/datum-engine";

import { journeyTitleOf, until } from "./helpers.js";

function journeyForm(withReview: boolean): FormDefinition {
  const pages: JourneyPage[] = [{ id: "first", title: "First page", components: ["name"] }];
  if (withReview) {
    pages.push({ id: "check", kind: "review", title: "Check your answers" });
  } else {
    pages.push({ id: "second", title: "Second page", components: ["email"] });
  }
  return {
    id: withReview ? "reviewing" : "plain-journey",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Review chunk" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "email", type: "text", configuration: { label: "Email" } }
        ]
      }
    },
    journey: { journeys: [{ id: "apply", pages }] }
  };
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

const card = (element: DatumFormElement): HTMLElement | null => element.shadowRoot!.querySelector<HTMLElement>("[data-journeys-error]");
const shadow = (element: DatumFormElement): ShadowRoot | null | undefined => element.renderer?.shadowRoot;
const heading = (element: DatumFormElement): string | undefined => journeyTitleOf(shadow(element)?.querySelector<HTMLElement>("[data-journey-heading]"));
const list = (element: DatumFormElement): HTMLElement | null | undefined => shadow(element)?.querySelector<HTMLElement>("[data-journey-review]");

/** Every draw of the renderer's shadow root: whether the Check answers heading was ever drawn without its list. */
function watchForEmptyCheck(element: DatumFormElement): { emptyDraws: number; stop(): void } {
  const seen = { emptyDraws: 0, stop: () => undefined as void };
  const root = shadow(element)!;
  const observer = new MutationObserver(() => {
    if (heading(element)?.includes("Check your answers") && !list(element)) {
      seen.emptyDraws += 1;
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  seen.stop = () => observer.disconnect();
  return seen;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  chunks.reviewFailure = undefined;
  chunks.reviewImports = 0;
  chunks.reviewReads = 0;
  chunks.engineImports = 0;
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

// Order matters: once the review chunk has loaded it stays on the page (module state), so the
// tests that need it unloaded or missing come first.
describe("<datum-form> never imports the Check answers chunk it does not need", () => {
  it("a journey with no Check answers page runs on the journeys chunk alone, with the kit that has no list", async () => {
    chunks.reviewFailure = new TypeError("must not be asked for");
    const element = document.createElement("datum-form");
    element.definition = journeyForm(false);
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    document.body.append(element);
    await element.ready;
    await until(() => heading(element) === "First page");
    expect(chunks.reviewImports).toBe(0);
    expect(errors).toHaveLength(0);
    expect(element.renderer!.journeyKit).toBe(createJourneyRenderKit());
    expect(element.renderer!.journeyKit).not.toBe(EagerJourneyRenderKit);
    await element.nextPage();
    await until(() => heading(element) === "Second page");
    expect(chunks.reviewImports).toBe(0);
  });

  it("a journey with a Check answers page whose features leave journeys out is one page and imports neither chunk", async () => {
    chunks.reviewFailure = new TypeError("must not be asked for");
    const element = document.createElement("datum-form");
    element.setAttribute("features", "print");
    element.definition = journeyForm(true);
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    document.body.append(element);
    await element.ready;
    expect(chunks.reviewImports).toBe(0);
    expect(chunks.engineImports).toBe(0);
    expect(errors).toHaveLength(0);
    expect(card(element)).toBeNull();
  });
});

describe("<datum-form> when the Check answers chunk cannot be imported", () => {
  it("leaves the journeys card and one datum-error naming the Check answers page; Retry builds the form, and its Check answers page draws its list on the first draw", async () => {
    const element = document.createElement("datum-form");
    element.definition = journeyForm(true);
    chunks.reviewFailure = new TypeError("Failed to fetch dynamically imported module: /datum-form-journey-review-chunk-abc.js");
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);

    await until(() => card(element));
    expect(card(element)!.getAttribute("role")).toBe("alert");
    expect(element.renderer!.hidden).toBe(true);
    expect(element.runtime).toBeUndefined();
    expect(ready).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("journeys.unavailable");
    expect(errors[0]!.message).toContain("The Check answers page");
    expect(errors[0]!.cause).toBeInstanceOf(Error);
    // Never the first page drawn without the chunk it needs.
    expect(heading(element)).toBeUndefined();
    await expect(element.nextPage()).rejects.toThrow(/Check answers page/);

    chunks.reviewFailure = undefined;
    const before = chunks.reviewImports;
    card(element)!.querySelector<HTMLButtonElement>("button[data-journeys-retry]")!.click();
    await until(() => ready.length === 1);
    expect(chunks.reviewImports).toBeGreaterThan(before);
    // One load that came: the bundle read once.
    expect(chunks.reviewReads).toBe(1);
    expect(card(element)).toBeNull();
    expect(element.renderer!.hidden).toBe(false);
    // The form is ready with the kit built over the Check answers kit: the full one.
    expect(element.renderer!.journeyKit).toBe(EagerJourneyRenderKit);
    await until(() => heading(element) === "First page");

    const watch = watchForEmptyCheck(element);
    element.runtime!.setValue("name", "Ada");
    await element.nextPage();
    await until(() => list(element));
    watch.stop();
    expect(heading(element)).toContain("Check your answers");
    expect(shadow(element)!.getElementById("check__review-name")?.querySelector("dd")?.textContent?.trim()).toBe("Ada");
    // The Check answers heading was never drawn without its list.
    expect(watch.emptyDraws).toBe(0);
    expect(errors).toHaveLength(1);
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  });
});

describe("<datum-form> once the Check answers chunk is on the page", () => {
  it("builds the next form with a Check answers page from it without asking again", async () => {
    const element = document.createElement("datum-form");
    element.definition = journeyForm(true);
    document.body.append(element);
    await element.ready;
    expect(chunks.reviewImports).toBe(0);
    // The earlier load is the one used: the loader read the chunk's bundle no second time.
    expect(chunks.reviewReads).toBe(0);
    expect(element.renderer!.journeyKit).toBe(EagerJourneyRenderKit);
  });
});
