import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Absent-code resilience for the builder's lazy surfaces: a host may deploy the bundle without a
 * feature's chunk. For each surface a rejected chunk load must reach the host as `datum-error` {message, cause}, leave an inline
 * accessible failure state with a Retry, leave the rest of the builder working, raise no
 * unhandled rejection, and be asked for again on Retry (no cached rejection). The REAL loaders
 * run here: what fails is the module each one dynamically imports (the mocks below make
 * that module's factory throw, which is how a missing file looks to `import()`), so each
 * loader's own forget-on-reject is what the Retry exercises. The excluded-feature half (zero
 * loader calls) lives in builder-features.test.ts. The Header & footer and Variables panels are
 * not here: the engine's builder index re-exports their modules statically, so no dynamic-import
 * failure can be staged in jsdom; their real loaders are driven by lazy-panel-loaders.test.ts and
 * their failure cards by builder-lazy-panels.test.ts.
 */
const { gone, gate } = vi.hoisted(() => {
  const state = {
    fail: { logic: 0, data: 0, languages: 0, palette: 0, overview: 0, tryIt: 0 } as Record<string, number>,
    // How many times each target module was asked for (a factory call is one fetch attempt).
    asked: { logic: 0, data: 0, languages: 0, palette: 0, overview: 0, tryIt: 0 } as Record<string, number>
  };
  const gateFor =
    (key: string) =>
    async (importOriginal: () => Promise<unknown>): Promise<unknown> => {
      state.asked[key] = (state.asked[key] ?? 0) + 1;
      if ((state.fail[key] ?? 0) > 0) {
        state.fail[key] = (state.fail[key] ?? 0) - 1;
        throw new Error(`${key}: chunk gone`);
      }
      return importOriginal();
    };
  return { gone: state, gate: gateFor };
});

vi.mock("../../../engine/form-engine/builder/logic/logic-surface.ts", async (importOriginal) => gate("logic")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/data/data-surface.ts", async (importOriginal) => gate("data")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/languages/languages-surface.ts", async (importOriginal) => gate("languages")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/palette/command-palette.ts", async (importOriginal) => gate("palette")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/overview/overview-surface.ts", async (importOriginal) => gate("overview")(importOriginal as never) as never);
vi.mock("../../../engine/form-engine/builder/web-component/try-it.ts", async (importOriginal) => gate("tryIt")(importOriginal as never) as never);

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import type { FormDefinition } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  for (const key of Object.keys(gone.fail)) {
    gone.fail[key] = 0;
    gone.asked[key] = 0;
  }
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  document.body.innerHTML = "";
});

async function mount(options: { journeys?: boolean; definition?: FormDefinition } = {}): Promise<{ element: DatumFormBuilderElement; errors: Array<{ message: string; cause: unknown }> }> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  if (!options.journeys) {
    element.setAttribute("journeys", "off");
  }
  element.definition = options.definition ?? sampleDefinition();
  const errors: Array<{ message: string; cause: unknown }> = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return { element, errors };
}

/** The import's rejection reached the host as the cause (vitest words a throwing mock factory its own way, with the original as its cause). */
function expectGone(cause: unknown): void {
  const texts: string[] = [];
  for (let at: unknown = cause; at instanceof Error && texts.length < 4; at = (at as { cause?: unknown }).cause) {
    texts.push(at.message);
  }
  expect(texts.join(" | ")).toMatch(/chunk gone|error when mocking a module/);
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

/** The form still takes an edit: the builder is not wedged by the missing chunk. */
function stillEdits(element: DatumFormBuilderElement): void {
  const id = element.controller!.addAfter("text", "fullName");
  expect(id).toBeTruthy();
  expect(JSON.stringify(element.definition)).toContain(`"${id}"`);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const surfaces = [
  { workspace: "logic", key: "logic", host: "[data-logic-host]", retry: "[data-logic-retry]", word: "Logic didn't load.", tag: "datum-builder-logic" },
  { workspace: "data", key: "data", host: "[data-data-host]", retry: "[data-data-retry]", word: "Data didn't load.", tag: "datum-builder-data" },
  { workspace: "languages", key: "languages", host: "[data-languages-host]", retry: "[data-languages-retry]", word: "Languages didn't load.", tag: "datum-builder-languages" }
] as const;

describe("a missing surface chunk", () => {
  for (const surface of surfaces) {
    it(`${surface.workspace}: datum-error, an inline alert with Retry, the form keeps working, Retry loads it`, async () => {
      const { element, errors } = await mount();
      gone.fail[surface.key] = 1;
      expect(element.setWorkspace(surface.workspace)).toBe(true);
      const host = shell(element).querySelector<HTMLElement>(surface.host)!;
      await until(() => host.querySelector(surface.retry));
      const card = host.querySelector('[role="alert"]')!;
      expect(card.textContent).toContain(surface.word);
      expect(card.textContent).toContain("Retry");
      expect(host.hidden).toBe(false);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe(surface.word);
      expectGone(errors[0]!.cause);
      // Back to the form: it takes an edit, and the missing chunk was asked for once.
      element.setWorkspace("form");
      stillEdits(element);
      expect(gone.asked[surface.key]).toBe(1);
      // Retry asks again (no cached rejection) and the surface arrives.
      element.setWorkspace(surface.workspace);
      host.querySelector<HTMLElement>(surface.retry)?.click();
      await until(() => host.querySelector(surface.tag));
      expect(gone.asked[surface.key]).toBeGreaterThanOrEqual(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await settle();
      expect(unhandled).toEqual([]);
      expect(errors).toHaveLength(1);
    });
  }

  it("the command palette: datum-error, the next open retries", async () => {
    const { element, errors } = await mount();
    gone.fail.palette = 1;
    await expect(element.builder!.openPalette()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("The command palette did not load. Try again.");
    expectGone(errors[0]!.cause);
    stillEdits(element);
    await element.builder!.openPalette();
    expect(gone.asked.palette).toBe(2);
    expect(shell(element).querySelector("datum-builder-palette")).toBeTruthy();
    expect(unhandled).toEqual([]);
  });

  it("Try it: datum-error, an alert with Try again, the editor keeps working, Try again loads it", async () => {
    const { element, errors } = await mount();
    gone.fail.tryIt = 1;
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
    canvas.shadowRoot!.querySelector<HTMLButtonElement>("[data-try-it]")!.click();
    const failed = (): Element | null => canvas.shadowRoot!.querySelector('[data-try-load="failed"]');
    await until(failed);
    expect(failed()!.getAttribute("role")).toBe("alert");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]!.message).toBe("Try it could not be loaded");
    expect(errors[0]!.cause).toBeTruthy();
    // The form still takes an edit, and Try again asks for the chunk once more and gets it.
    stillEdits(element);
    canvas.shadowRoot!.querySelector<HTMLButtonElement>("[data-try-load-retry]")!.click();
    // Neither the failed card nor the "starting" one is left: the chunk came back and drew the panel.
    await until(() => canvas.shadowRoot!.querySelector("[data-try-load]") === null);
    expect(gone.asked.tryIt).toBeGreaterThanOrEqual(2);
    expect(unhandled).toEqual([]);
  });

  it("the Journeys overview: datum-error, an alert with Retry, Retry loads it", async () => {
    const definition = { ...sampleDefinition(), journey: { journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }] } } as FormDefinition;
    const { element, errors } = await mount({ journeys: true, definition });
    await until(() => element.journeyMode !== undefined);
    gone.fail.overview = 1;
    expect(element.setWorkspace("journeys")).toBe(true);
    const host = shell(element).querySelector<HTMLElement>("[data-overview-host]")!;
    await until(() => host.querySelector("[data-overview-retry]"));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Retry");
    expect(errors.some((entry) => entry.message.startsWith("The journeys didn't load."))).toBe(true);
    expectGone(errors.find((entry) => entry.message.startsWith("The journeys didn't load."))!.cause);
    element.setWorkspace("form");
    stillEdits(element);
    element.setWorkspace("journeys");
    host.querySelector<HTMLElement>("[data-overview-retry]")?.click();
    await until(() => host.querySelector("datum-builder-overview"));
    expect(gone.asked.overview).toBeGreaterThanOrEqual(2);
    await settle();
    expect(unhandled).toEqual([]);
  });
});
