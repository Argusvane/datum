import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Absent-code resilience for the PDF and Journeys mode chunks: Retry keeps focus and shows it is busy; a failed side is not fetched again
 * by unrelated flushes (only by Retry or a reconnect); a failed load drops the side asked for by
 * `mode`, so a later Retry does not yank the author there; the seed follower reports formulas it
 * could not rewrite. The mode loaders are wrapped so each test can hold, fail or count a load.
 */
type PdfLoader = typeof import("../../../engine/form-engine/builder/pdf-designer/pdf-mode-loader.ts");
type JourneyLoader = typeof import("../../../engine/form-engine/builder/journey-designer/journey-mode-loader.ts");

type Hold = { promise: Promise<unknown>; resolve: () => void; reject: (error: unknown) => void };
const control = vi.hoisted(() => ({
  pdfCalls: 0,
  journeyCalls: 0,
  holdPdf: undefined as undefined | Hold,
  holdJourney: undefined as undefined | Hold
}));

vi.mock("../../../engine/form-engine/builder/pdf-designer/pdf-mode-loader.ts", async (importOriginal) => {
  const actual = await importOriginal<PdfLoader>();
  return {
    ...actual,
    loadPdfBuilderMode: () => {
      control.pdfCalls += 1;
      return control.holdPdf ? control.holdPdf.promise : actual.loadPdfBuilderMode();
    },
    loadedPdfBuilderMode: () => (control.holdPdf ? undefined : actual.loadedPdfBuilderMode())
  };
});
vi.mock("../../../engine/form-engine/builder/journey-designer/journey-mode-loader.ts", async (importOriginal) => {
  const actual = await importOriginal<JourneyLoader>();
  return {
    ...actual,
    loadJourneyBuilderMode: () => {
      control.journeyCalls += 1;
      return control.holdJourney ? control.holdJourney.promise : actual.loadJourneyBuilderMode();
    },
    loadedJourneyBuilderMode: () => (control.holdJourney ? undefined : actual.loadedJourneyBuilderMode())
  };
});

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

async function hold(kind: "pdf" | "journey"): Promise<Hold> {
  const module =
    kind === "pdf"
      ? await vi.importActual("../../../engine/form-engine/builder/pdf-designer/pdf-builder-mode.ts")
      : await vi.importActual("../../../engine/form-engine/builder/journey-designer/journey-builder-mode.ts");
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = () => yes(module);
    reject = no;
  });
  promise.catch(() => undefined);
  const held = { promise, resolve, reject };
  if (kind === "pdf") {
    control.holdPdf = held;
  } else {
    control.holdJourney = held;
  }
  return held;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function definitionWith(when?: string): FormDefinition {
  const definition = sampleDefinition();
  definition.pdf = {
    layouts: [
      {
        id: "letter",
        kind: "generated",
        name: "Letter",
        ...(when !== undefined ? { when } : {}),
        root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
      }
    ],
    defaultLayout: "letter"
  } as unknown as NonNullable<FormDefinition["pdf"]>;
  definition.journey = {
    journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }]
  } as NonNullable<FormDefinition["journey"]>;
  return definition;
}

async function mount(setup: (element: DatumFormBuilderElement) => void, definition = definitionWith()): Promise<{ element: DatumFormBuilderElement; errors: string[] }> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  const errors: string[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  setup(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return { element, errors };
}

afterEach(() => {
  document.body.innerHTML = "";
  control.holdPdf = undefined;
  control.holdJourney = undefined;
  control.pdfCalls = 0;
  control.journeyCalls = 0;
});

describe("a failed mode chunk, on retry", { timeout: 20000 }, () => {
  it("keeps the card and focus on Retry while the chunk comes back, busy but still the focused button", async () => {
    const first = await hold("journey");
    const { element, errors } = await mount((el) => el.setAttribute("features", "-pdf"));
    first.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    const root = element.shadowRoot!;
    const retry = root.querySelector<HTMLButtonElement>('[data-mode-retry="journeys"]')!;
    expect(root.querySelector('[data-mode-status] [role="alert"]')).toBeTruthy();
    retry.focus();
    expect(root.activeElement).toBe(retry);
    // The second load is held: the card turns into a busy status, the button is the same kind and keeps focus.
    const second = await hold("journey");
    retry.click();
    await until(() => root.querySelector('[data-mode-status] [data-mode-loading="journeys"]'));
    const busy = root.querySelector<HTMLButtonElement>('[data-mode-retry="journeys"]')!;
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector('[data-mode-status] [role="alert"]')).toBeNull();
    expect(root.activeElement).toBe(busy);
    // A second press while busy asks for nothing more.
    const asked = control.journeyCalls;
    busy.click();
    await settle();
    expect(control.journeyCalls).toBe(asked);
    // It arrives: the card goes, the mode is registered.
    second.resolve();
    await until(() => element.journeyMode !== undefined);
    expect(root.querySelector('[data-mode-status]')?.hasAttribute("hidden")).toBe(true);
  });

  it("the PDF side fails the same way: datum-error, a Retry card, and Retry registers the mode", async () => {
    const first = await hold("pdf");
    const { element, errors } = await mount((el) => el.setAttribute("features", "-journeys"));
    first.reject(new Error("pdf chunk missing"));
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("PDF");
    const root = element.shadowRoot!;
    expect(root.querySelector('[data-mode-status] [role="alert"]')).toBeTruthy();
    const retry = root.querySelector<HTMLButtonElement>('[data-mode-retry="pdf"]')!;
    expect(retry).toBeTruthy();
    // The form still takes an edit while the side is missing.
    expect(element.controller!.addAfter("text", "fullName")).toBeTruthy();
    const asked = control.pdfCalls;
    control.holdPdf = undefined;
    retry.click();
    await until(() => element.pdfMode !== undefined);
    expect(control.pdfCalls).toBeGreaterThan(asked);
    expect(root.querySelector('[data-mode-status]')?.hasAttribute("hidden")).toBe(true);
  });

  it("is not fetched again by unrelated flushes, only by Retry or a reconnect", async () => {
    const first = await hold("journey");
    const { element, errors } = await mount((el) => el.setAttribute("features", "-pdf"));
    first.reject(new Error("chunk missing"));
    await until(() => errors.length === 1);
    const asked = control.journeyCalls;
    element.setAttribute("locale", "fr-CA");
    element.setAttribute("theme", "datum-dark");
    element.definition = definitionWith();
    await settle();
    await settle();
    expect(control.journeyCalls).toBe(asked);
    expect(errors).toHaveLength(1);
    // A reconnect asks again.
    control.holdJourney = undefined;
    const parent = element.parentElement!;
    element.remove();
    parent.append(element);
    await until(() => element.journeyMode !== undefined);
    expect(control.journeyCalls).toBeGreaterThan(asked);
  });

  it("forgets the side asked for by mode, so a later Retry does not yank the author into it", async () => {
    const first = await hold("journey");
    const { element, errors } = await mount((el) => {
      el.setAttribute("features", "-pdf");
      el.setAttribute("mode", "journeys");
    });
    first.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    expect(element.mode).toBe("form");
    control.holdJourney = undefined;
    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-mode-retry="journeys"]')!.click();
    await until(() => element.journeyMode !== undefined);
    await settle();
    expect(element.builder!.mode).toBe("form");
  });

  it("reports a formula a rename could not follow into a layout of a side whose mode is not registered", async () => {
    const { element, errors } = await mount((el) => el.setAttribute("features", "-pdf"), definitionWith("fullName ="));
    await settle();
    errors.length = 0;
    element.controller!.renameId("fullName", "applicantName");
    await until(() => errors.some((message) => message.includes("does not parse")));
    const message = errors.find((entry) => entry.includes("does not parse"))!;
    expect(message).toContain("letter");
    expect(message).toContain("fullName");
    expect(message).toContain("applicantName");
    // Left as written, not rewritten.
    expect(element.definition.pdf).toBeDefined();
  });
});
