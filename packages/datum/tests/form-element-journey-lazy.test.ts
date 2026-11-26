import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

/*
 * <datum-form>'s async build for a form with journeys: the journeys runtime
 * (the engine and the render kit) is a lazy chunk, loaded through `loadJourneyEngine()` and handed
 * to the runtime and the renderer the element builds. Mocked here to resolve, to reject and to
 * hang, so each state of the build can be held still:
 *
 * - every form builds the same way: a plain form, or one whose `features`
 *   leave journeys out, is ready a microtask after the definition lands and never asks for the chunk;
 * - a journey form is ready (`datum-ready`, and `ready`) only once the chunk has arrived; the calls
 *   a page makes meanwhile wait and run in the order made, the synchronous ones throw saying the
 *   form is still building, and settings made meanwhile land in the runtime when it is built;
 * - a chunk that does not arrive leaves an alert with Retry (never the form drawn as one page),
 *   one `datum-error` {message, cause}, the waiting calls rejected with the same error, and no
 *   unhandled rejection; Retry asks again and builds;
 * - a newer definition supersedes a build still waiting, which never binds;
 * - the engine and the kit are always the element's to pass, never the page's default slot.
 */

const loader = vi.hoisted(() => ({
  calls: 0,
  load: undefined as undefined | (() => Promise<unknown>),
  loaded: undefined as unknown
}));
vi.mock("../src/journey-engine-loader.ts", () => ({
  loadJourneyEngine: () => {
    loader.calls += 1;
    const load = loader.load!();
    // As the real loader: the bundle is readable at once after it has arrived; a failure is not remembered.
    load.then(
      (bundle) => {
        loader.loaded = bundle;
      },
      () => undefined
    );
    return load;
  },
  loadedJourneyEngine: () => loader.loaded
}));

// Counts how often the diagnostics chunk is asked for (its factory runs once, at the first import).
const diagnostics = vi.hoisted(() => ({ loads: 0 }));
vi.mock("../src/journey-diagnostics.ts", () => {
  diagnostics.loads += 1;
  return { diagnoseJourneys: () => [] };
});

import "../src/form.js";
import type { DatumErrorDetail, DatumFormElement, DatumFormPageChangeDetail, DatumFormReadyDetail } from "../src/form.js";
import { ChunkLoadError } from "../src/chunk-load-error.js";
import {
  EagerJourneyEngine,
  EagerJourneyRenderKit,
  FormRuntime,
  NoopJourneyEngine,
  NoopJourneyRenderKit,
  defaultJourneyEngine,
  defaultJourneyRenderKit,
  setDefaultJourneyEngine,
  setDefaultJourneyRenderKit,
  type FormDefinition,
  type JourneyEngine,
  type JourneyRenderKit
} from "@argusvane/datum-engine";

import { journeyTitleOf, until } from "./helpers.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

// The chunk's bundle: `forDefinition` answers the pair for a definition (these journeys have no Check answers page).
const BUNDLE = {
  engine: EagerJourneyEngine,
  renderKit: EagerJourneyRenderKit,
  forDefinition: () => Promise.resolve({ engine: EagerJourneyEngine, renderKit: EagerJourneyRenderKit }),
  sentinel: "datum-journey-engine-chunk"
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function plainForm(id = "plain"): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Plain" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true } },
          { id: "email", type: "text", configuration: { label: "Email" } }
        ]
      }
    }
  };
}

/** Two pages: the name, then the email. */
function journeyForm(id = "lazy"): FormDefinition {
  return {
    ...plainForm(id),
    journey: {
      journeys: [
        {
          id: "apply",
          validation: { continue: "page" },
          pages: [
            { id: "first", title: "First page", components: ["name"] },
            { id: "second", title: "Second page", components: ["email"] }
          ]
        }
      ]
    }
  };
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

function create(definition: FormDefinition, setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  element.definition = definition;
  setup?.(element);
  return element;
}

function heading(element: DatumFormElement): string | undefined {
  return journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
}

function card(element: DatumFormElement): HTMLElement | null {
  return element.shadowRoot!.querySelector<HTMLElement>("[data-journeys-error]");
}

/** Lets every queued microtask (and the timers they schedule) run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
let slotEngine: JourneyEngine;
let slotKit: JourneyRenderKit;

beforeEach(() => {
  loader.calls = 0;
  loader.load = () => Promise.resolve(BUNDLE);
  loader.loaded = undefined;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  slotEngine = defaultJourneyEngine();
  slotKit = defaultJourneyRenderKit();
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  setDefaultJourneyEngine(slotEngine);
  setDefaultJourneyRenderKit(slotKit);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("<datum-form> without the journeys runtime: nothing to fetch, built in a microtask", () => {
  it("a plain form is ready a microtask after it is attached, with the Noop pair, and never asks for the chunk", async () => {
    // The page's default slot names the eager pair (a builder bundle on the page): the element passes its own.
    setDefaultJourneyEngine(EagerJourneyEngine);
    setDefaultJourneyRenderKit(EagerJourneyRenderKit);
    const element = create(plainForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    // One build path for every form: the runtime lands in a microtask, not inside append().
    expect(ready).toHaveLength(0);
    await element.ready;
    expect(ready).toHaveLength(1);
    expect(element.runtime).toBe(ready[0]!.runtime);
    expect(element.renderer!.journeyKit).toBe(NoopJourneyRenderKit);
    expect(loader.calls).toBe(0);
  });

  it("a form whose features leave journeys out is one page, ready a microtask after attach, warned about once, and never asks for the chunk", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const element = create(journeyForm(), (el) => el.setAttribute("features", "print"));
    element.setAttribute("journey", "apply");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await element.ready;
    expect(ready).toHaveLength(1);
    expect(element.runtime!.journeyView()).toBeUndefined();
    expect(element.renderer!.journeyKit).toBe(NoopJourneyRenderKit);
    expect(loader.calls).toBe(0);
    const ignored = warn.mock.calls.filter(([line]) => String(line).includes('does not include "journeys"'));
    expect(ignored).toHaveLength(1);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("no journey engine"))).toHaveLength(0);
  });

  it("asks for nothing at connect for a pending src unless the page says a journey runs, and never when journeys are left out", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const quiet = document.createElement("datum-form");
    quiet.setAttribute("src", "/forms/a.json");
    document.body.append(quiet);
    expect(loader.calls).toBe(0);

    const excluded = document.createElement("datum-form");
    excluded.setAttribute("src", "/forms/b.json");
    excluded.setAttribute("journey", "apply");
    excluded.setAttribute("features", "minimal");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    document.body.append(excluded);
    expect(loader.calls).toBe(0);

    const journey = document.createElement("datum-form");
    journey.setAttribute("src", "/forms/c.json");
    journey.setAttribute("journey", "apply");
    document.body.append(journey);
    expect(loader.calls).toBe(1);

    const listed = document.createElement("datum-form");
    listed.setAttribute("src", "/forms/d.json");
    listed.setAttribute("features", "journeys print");
    document.body.append(listed);
    expect(loader.calls).toBe(2);
  });
});

describe("<datum-form> with journeys: the build waits for the journeys runtime", () => {
  it("is ready only once the chunk has arrived, runs and draws with the pair it loaded (not the page's default), and starts the journey silently", async () => {
    // Nothing on the page registered an engine: the element must hand its runtime the loaded one.
    setDefaultJourneyEngine(NoopJourneyEngine);
    setDefaultJourneyRenderKit(NoopJourneyRenderKit);
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    const moves = listen<DatumFormPageChangeDetail>(element, "datum-page-change");
    document.body.append(element);
    await settle();
    expect(loader.calls).toBe(1);
    expect(ready).toHaveLength(0);
    expect(element.runtime).toBeUndefined();
    expect(element.renderer!.runtime).toBeUndefined();
    expect(element.renderer!.shadowRoot!.querySelector("p")?.textContent).toBe("Loading form…");

    load.resolve(BUNDLE);
    await until(() => ready.length === 1);
    expect(element.runtime).toBe(ready[0]!.runtime);
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
    expect(element.renderer!.journeyKit).toBe(EagerJourneyRenderKit);
    await until(() => heading(element) === "First page");
    expect(moves).toHaveLength(0);
  });

  it("builds a later journey form on the page at once, the chunk being there already", async () => {
    const first = create(journeyForm("one"));
    const firstReady = listen<DatumFormReadyDetail>(first, "datum-ready");
    document.body.append(first);
    await until(() => firstReady.length === 1);

    const second = create(journeyForm("two"));
    const ready = listen<DatumFormReadyDetail>(second, "datum-ready");
    document.body.append(second);
    // Not a fetch: the same microtask a plain form takes.
    expect(ready).toHaveLength(0);
    await second.ready;
    expect(ready).toHaveLength(1);
    expect(second.runtime!.journeyView()?.pageId).toBe("first");
    expect(loader.calls).toBe(1);
  });

  it("queues the calls made while it loads and runs them in order once built; the synchronous ones throw; settings made meanwhile land in the runtime", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const validate = vi.spyOn(FormRuntime.prototype, "validate");
    const nextPage = vi.spyOn(FormRuntime.prototype, "nextPage");
    const goToPage = vi.spyOn(FormRuntime.prototype, "goToPage");
    const submit = vi.spyOn(FormRuntime.prototype, "submit");
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();

    element.values = { name: "Ada" };
    const validated = element.validate({ focus: false });
    const moved = element.nextPage();
    const jumped = element.goToPage("first");
    const submitted = element.submit();
    expect(() => element.setErrors([])).toThrow(/still building/);
    expect(() => element.setLocale("en")).toThrow(/still building/);
    await settle();
    expect(validate).not.toHaveBeenCalled();
    expect(nextPage).not.toHaveBeenCalled();

    load.resolve(BUNDLE);
    const outcomes = await Promise.allSettled([validated, moved, jumped, submitted]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(ready).toHaveLength(1);
    const order = [validate, nextPage, goToPage, submit].map((spy) => spy.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The values set while it loaded were the runtime's from the start.
    expect(element.values).toMatchObject({ name: "Ada" });
    expect((outcomes[0] as PromiseFulfilledResult<unknown[]>).value).toEqual([]);
  });

  it("settles before datum-ready is heard: a listener's own synchronous call works", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    let stored: unknown;
    element.addEventListener("datum-ready", () => {
      stored = element.setErrors([{ code: "server", componentId: "name", message: "Taken" }]);
    });
    document.body.append(element);
    load.resolve(BUNDLE);
    await until(() => stored !== undefined);
    expect(stored).toHaveLength(1);
  });

  it("keeps the form it replaces up and bound until the swap", async () => {
    const element = create(plainForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    const changes = listen<{ path?: string }>(element, "datum-change");
    document.body.append(element);
    await element.ready;
    const plain = element.runtime!;
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    element.definition = journeyForm();
    await settle();
    expect(element.runtime).toBe(plain);
    expect(element.renderer!.runtime).toBe(plain);
    plain.setValue("email", "ada@example.com");
    expect(changes.map((change) => change.path)).toEqual(["email"]);

    load.resolve(BUNDLE);
    await until(() => ready.length === 2);
    expect(element.runtime).not.toBe(plain);
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
  });

  it("drops a build a newer definition superseded: only the newest binds, and the waiting calls run on it", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm("old"));
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();
    const moved = element.nextPage();
    element.definition = journeyForm("new");
    await settle();
    load.resolve(BUNDLE);
    await until(() => ready.length === 1);
    await settle();
    expect(ready).toHaveLength(1);
    expect(element.runtime!.definition().id).toBe("new");
    await expect(moved).resolves.toMatchObject({ ok: false });
  });

  it("drops a waiting build when the definition becomes a plain form, which is built at once", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();
    const moved = element.nextPage();
    element.definition = plainForm();
    await until(() => ready.length === 1);
    const plain = element.runtime!;
    expect(plain.definition().id).toBe("plain");
    await expect(moved).resolves.toMatchObject({ ok: false, reason: "no-journey" });
    load.resolve(BUNDLE);
    await settle();
    expect(ready).toHaveLength(1);
    expect(element.runtime).toBe(plain);
  });

  it("taken out of the page while it loads, it builds when it is attached again", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();
    element.remove();
    load.resolve(BUNDLE);
    await settle();
    expect(ready).toHaveLength(0);
    document.body.append(element);
    await until(() => ready.length === 1);
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
  });
});

describe("<datum-form> with journeys: the journeys runtime does not arrive", () => {
  const browserError = new TypeError("Failed to fetch dynamically imported module: /datum-form-journey-engine-chunk-x.js");
  const failure = (): ChunkLoadError => new ChunkLoadError("The journeys runtime (datum-form-journey-engine-chunk-*.js)", browserError);

  it("shows the alert with Retry instead of the form (never one page), reports once, rejects the waiting calls, and leaves no unhandled rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = failure();
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();
    const moved = element.nextPage();
    const submitted = element.submit();
    const validated = element.validate();
    load.reject(error);
    await expect(moved).rejects.toBe(error);
    await expect(submitted).rejects.toBe(error);
    await expect(validated).rejects.toBe(error);
    await settle();

    expect(ready).toHaveLength(0);
    expect(errors).toEqual([{ code: "journeys.unavailable", message: error.message, cause: browserError }]);
    expect(error.message).toMatch(/^The journeys runtime \(datum-form-journey-engine-chunk-\*\.js\) could not be loaded: /);
    const alert = card(element)!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.hasAttribute("data-form-error")).toBe(true);
    expect(alert.textContent).toContain("This form could not be loaded because part of it did not arrive.");
    expect(alert.querySelector("button[data-journeys-retry]")?.textContent).toBe("Try again");
    // Never the form drawn as one page instead.
    expect(element.runtime).toBeUndefined();
    expect(element.renderer!.runtime).toBeUndefined();
    expect(element.renderer!.hidden).toBe(true);
    // The methods keep saying why until a build replaces the failure.
    await expect(element.goToPage("second")).rejects.toBe(error);
    await expect(element.restoreDraft()).rejects.toBe(error);
    expect(() => element.setErrors([])).toThrow(error);
    expect(unhandled).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("words the alert with the page's texts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(failure());
    const element = create(journeyForm(), (el) => {
      el.texts = { journeysUnavailable: "Le formulaire n'a pas pu être chargé.", retry: "Réessayer" };
    });
    document.body.append(element);
    await until(() => card(element));
    expect(card(element)!.querySelector(".form-error__message")?.textContent).toBe("Le formulaire n'a pas pu être chargé.");
    expect(card(element)!.querySelector("[data-journeys-retry]")?.textContent).toBe("Réessayer");
  });

  it("Retry asks for the chunk again and builds: the alert goes, the journey shows, and datum-ready fires", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(failure());
    const element = create(journeyForm());
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await until(() => card(element));
    expect(loader.calls).toBe(1);

    loader.load = () => Promise.resolve(BUNDLE);
    card(element)!.querySelector<HTMLButtonElement>("[data-journeys-retry]")!.click();
    await until(() => ready.length === 1);
    expect(loader.calls).toBe(2);
    expect(card(element)).toBeNull();
    expect(element.renderer!.hidden).toBe(false);
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
    await until(() => heading(element) === "First page");
    expect(errors).toHaveLength(1);
    await expect(element.nextPage()).resolves.toMatchObject({ ok: false });
    expect(unhandled).toEqual([]);
  });

  it("a Retry that fails again shows the alert again and reports the new failure once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(failure());
    const element = create(journeyForm());
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    document.body.append(element);
    await until(() => card(element));
    card(element)!.querySelector<HTMLButtonElement>("[data-journeys-retry]")!.click();
    await until(() => errors.length === 2);
    await settle();
    expect(loader.calls).toBe(2);
    expect(element.shadowRoot!.querySelectorAll("[data-journeys-error]")).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(unhandled).toEqual([]);
  });

  it("a plain definition after the failure builds at once and takes the alert down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(failure());
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await until(() => card(element));
    element.definition = plainForm();
    await until(() => ready.length === 1);
    expect(card(element)).toBeNull();
    expect(element.renderer!.hidden).toBe(false);
    expect(loader.calls).toBe(1);
  });
});

describe("<datum-form> with journeys: a build pending when other settings change", () => {
  it("never carries the answers of the form it replaces into the new one, even when translations arrive during the load", async () => {
    const element = create(plainForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await element.ready;
    element.runtime!.setValue("name", "from the OLD form");
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    element.definition = journeyForm();
    await settle();
    element.translations = { fr: { name: "Nom" } } as never;
    await settle();
    load.resolve(BUNDLE);
    await until(() => ready.length === 2);
    await settle();
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
    expect(JSON.stringify(element.runtime!.formValues())).not.toContain("OLD");
    expect(element.values.name).toBeUndefined();
  });

  it("does not land values or a journey set during the swap on the form being replaced", async () => {
    const element = create(plainForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    const changes = listen<{ path?: string }>(element, "datum-change");
    document.body.append(element);
    await element.ready;
    const plain = element.runtime!;
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    element.definition = journeyForm();
    await settle();
    const setValues = vi.spyOn(plain, "setValues");
    element.values = { email: "ada@example.com" };
    element.journey = "apply";
    await settle();
    expect(setValues).not.toHaveBeenCalled();
    expect(plain.formValues()).not.toHaveProperty("email");
    expect(changes).toEqual([]);
    load.resolve(BUNDLE);
    await until(() => ready.length === 2);
    expect(element.runtime).not.toBe(plain);
    expect(element.runtime!.formValues()).toMatchObject({ email: "ada@example.com" });
    expect(element.runtime!.journeyView()?.journeyId).toBe("apply");
  });

  it("rejects the calls queued on a build when the element is removed, rather than leaving them hanging; attached again it builds", async () => {
    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const element = create(journeyForm());
    const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
    document.body.append(element);
    await settle();
    const validated = element.validate();
    element.remove();
    await expect(validated).rejects.toThrow(/removed from the page/);
    load.resolve(BUNDLE);
    await settle();
    expect(ready).toHaveLength(0);
    document.body.append(element);
    await until(() => ready.length === 1);
    await expect(element.validate()).resolves.toBeDefined();
    expect(unhandled).toEqual([]);
  });

  it("keeps the hidden renderer hidden against a host rule on ::part(form), and the card shows beside it", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(new TypeError("Failed to fetch"));
    const element = create(journeyForm());
    document.body.append(element);
    await until(() => card(element));
    expect(element.renderer!.hasAttribute("hidden")).toBe(true);
    // A normal shadow declaration loses to the host's ::part(form) { display: block }; !important wins.
    const style = element.shadowRoot!.querySelector("style")!.textContent!;
    expect(style).toMatch(/datum-form-renderer\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});

describe("<datum-form debug> asks for the journey diagnostics only for a form with journeys", () => {
  it("a plain form with debug never loads the diagnostics chunk; a journey form does", async () => {
    const before = diagnostics.loads;
    const plain = create(plainForm("dbg-plain"), (element) => element.setAttribute("debug", ""));
    document.body.append(plain);
    await settle();
    expect(diagnostics.loads).toBe(before);
    expect(loader.calls).toBe(0);

    const journey = create(journeyForm("dbg-journey"), (element) => element.setAttribute("debug", ""));
    document.body.append(journey);
    await until(() => diagnostics.loads > before);
    // Turning debug on later for a plain form asks for nothing either.
    const later = create(plainForm("dbg-later"));
    document.body.append(later);
    const seen = diagnostics.loads;
    later.setAttribute("debug", "");
    await settle();
    expect(diagnostics.loads).toBe(seen);
  });
});

describe("<datum-form> ready", () => {
  const browserError = new TypeError("Failed to fetch dynamically imported module: /datum-form-journey-engine-chunk-x.js");
  const failure = (): ChunkLoadError => new ChunkLoadError("The journeys runtime (datum-form-journey-engine-chunk-*.js)", browserError);

  it("resolves after datum-ready has been dispatched, for a plain form and for the first journey form", async () => {
    const order: string[] = [];
    const plain = create(plainForm());
    plain.addEventListener("datum-ready", () => order.push("plain event"));
    const plainReady = plain.ready.then(() => order.push("plain ready"));
    document.body.append(plain);
    await plainReady;
    expect(order).toEqual(["plain event", "plain ready"]);

    const load = deferred<typeof BUNDLE>();
    loader.load = () => load.promise;
    const journey = create(journeyForm());
    journey.addEventListener("datum-ready", () => order.push("journey event"));
    let settled = false;
    const journeyReady = journey.ready.then(() => {
      settled = true;
      order.push("journey ready");
    });
    document.body.append(journey);
    await settle();
    // Not before the chunk has arrived.
    expect(settled).toBe(false);
    load.resolve(BUNDLE);
    await journeyReady;
    expect(order.slice(2)).toEqual(["journey event", "journey ready"]);
  });

  it("is resolved already for a form that is ready, and the same promise until a new build starts", async () => {
    const element = create(plainForm());
    document.body.append(element);
    await element.ready;
    const first = element.ready;
    expect(element.ready).toBe(first);
    await expect(first).resolves.toBeUndefined();
    element.definition = plainForm("second");
    // A definition set but not yet built: ready is for that build, not the last one.
    const next = element.ready;
    expect(next).not.toBe(first);
    await next;
    expect(element.runtime!.definition().id).toBe("second");
  });

  it("rejects with the ChunkLoadError when the journeys runtime does not arrive, with no unhandled rejection when nobody awaited it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = failure();
    loader.load = () => Promise.reject(error);
    const asked = create(journeyForm("asked"));
    const wait = asked.ready;
    document.body.append(asked);
    await expect(wait).rejects.toBe(error);

    // Never asked for while the build ran: still told, when asked for after the card is up.
    const quiet = create(journeyForm("quiet"));
    document.body.append(quiet);
    await until(() => card(quiet));
    await expect(quiet.ready).rejects.toBe(error);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("rejects with the refusal when the runtime will not take the definition", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const definition = plainForm("refused");
    definition.root.children!.content![1]!.rules = { visibleWhen: "name +" } as never;
    const element = create(definition, (el) => el.setAttribute("formula-errors", "fail"));
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    document.body.append(element);
    await expect(element.ready).rejects.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(element.runtime).toBeUndefined();
  });

  it("is a fresh promise after Retry, and resolves when the retried build lands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    loader.load = () => Promise.reject(failure());
    const element = create(journeyForm());
    document.body.append(element);
    const failed = element.ready;
    await expect(failed).rejects.toBeInstanceOf(ChunkLoadError);
    await until(() => card(element));
    expect(element.ready).toBe(failed);

    loader.load = () => Promise.resolve(BUNDLE);
    card(element)!.querySelector<HTMLButtonElement>("[data-journeys-retry]")!.click();
    const fresh = element.ready;
    expect(fresh).not.toBe(failed);
    await expect(fresh).resolves.toBeUndefined();
    expect(element.runtime!.journeyView()?.pageId).toBe("first");
  });

  it("is not rejected by a build that a newer request superseded, whichever way the old one ends", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stale = deferred<typeof BUNDLE>();
    loader.load = () => stale.promise;
    const element = create(journeyForm("old"));
    document.body.append(element);
    await settle();
    const wait = element.ready;
    const outcome = vi.fn();
    wait.then(() => outcome("resolved"), () => outcome("rejected"));
    element.definition = plainForm("new");
    // The old load fails after the new definition was built: nothing is rejected, no card, no error.
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    await settle();
    stale.reject(failure());
    await settle();
    expect(outcome.mock.calls).toEqual([["resolved"]]);
    expect(element.ready).toBe(wait);
    expect(card(element)).toBeNull();
    expect(errors).toHaveLength(0);
    expect(element.runtime!.definition().id).toBe("new");
  });

  it("a chunk failure in the checkpoint where a new definition is set does not reject: ready follows the new build", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stale = deferred<typeof BUNDLE>();
    loader.load = () => stale.promise;
    const element = create(journeyForm("old"));
    document.body.append(element);
    await settle();
    const wait = element.ready;
    const outcome = vi.fn();
    wait.then(() => outcome("resolved"), () => outcome("rejected"));
    // The failure's reaction is queued before the new definition's flush: it runs while the new
    // build is requested but not started.
    stale.reject(failure());
    element.definition = plainForm("new");
    await wait;
    await settle();
    expect(outcome.mock.calls).toEqual([["resolved"]]);
    expect(card(element)).toBeNull();
    expect(element.runtime!.definition().id).toBe("new");
  });

  it("a datum-ready listener that triggers a rebuild: ready resolves once, for the final build", async () => {
    const element = create(plainForm("first"));
    let readyEvents = 0;
    element.addEventListener("datum-ready", () => {
      readyEvents += 1;
      if (readyEvents === 1) {
        element.definition = plainForm("final");
      }
    });
    const wait = element.ready;
    let eventsWhenReady = -1;
    wait.then(() => {
      eventsWhenReady = readyEvents;
    });
    document.body.append(element);
    await wait;
    await settle();
    expect(readyEvents).toBe(2);
    expect(eventsWhenReady).toBe(2);
    expect(element.runtime!.definition().id).toBe("final");
  });

  it("rejects when the src cannot be fetched, instead of staying pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const element = document.createElement("datum-form");
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    element.setAttribute("src", "/missing-form.json");
    const wait = element.ready;
    document.body.append(element);
    await expect(wait).rejects.toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(element.runtime).toBeUndefined();
  });

  it("rejects when the src is not a usable definition", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 })));
    const element = document.createElement("datum-form");
    element.setAttribute("src", "/bad-form.json");
    const wait = element.ready;
    document.body.append(element);
    await expect(wait).rejects.toBeDefined();
  });

  it("with no definition settles once one is set and built", async () => {
    const element = document.createElement("datum-form");
    document.body.append(element);
    const wait = element.ready;
    const outcome = vi.fn();
    wait.then(() => outcome("resolved"), () => outcome("rejected"));
    await settle();
    expect(outcome).not.toHaveBeenCalled();
    expect(element.runtime).toBeUndefined();
    element.definition = plainForm();
    await wait;
    expect(outcome.mock.calls).toEqual([["resolved"]]);
    expect(element.runtime).toBeDefined();
  });

  it("is still pending while the element is out of the page, and settles when it is attached and built", async () => {
    const element = create(plainForm());
    const wait = element.ready;
    const outcome = vi.fn();
    wait.then(() => outcome("resolved"), () => outcome("rejected"));
    await settle();
    expect(outcome).not.toHaveBeenCalled();
    document.body.append(element);
    await wait;
    expect(outcome.mock.calls).toEqual([["resolved"]]);
  });
});
