import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The PDF and Journeys modes as chunks. <datum-form-builder> asks the
 * loaders for a mode only while that side is on and its workspace shown; a load that resolves
 * after the side went off, the workspace was hidden or the element was taken off the page
 * registers nothing (or waits for the next connect); the definition round trips untouched while
 * a mode is coming. The loaders are wrapped here so each test can count, hold or fail a load.
 */

type PdfLoader = typeof import("../../../engine/form-engine/builder/pdf-designer/pdf-mode-loader.ts");
type JourneyLoader = typeof import("../../../engine/form-engine/builder/journey-designer/journey-mode-loader.ts");

const control = vi.hoisted(() => ({
  pdfCalls: 0,
  journeyCalls: 0,
  /** While set, the loaders answer through these instead of the real chunk, and say nothing is loaded yet. */
  holdPdf: undefined as undefined | { promise: Promise<unknown>; resolve: () => void; reject: (error: unknown) => void },
  holdJourney: undefined as undefined | { promise: Promise<unknown>; resolve: () => void; reject: (error: unknown) => void }
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
import type { FormDefinition, PdfGeneratedLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { modesReady, sampleDefinition, until, pdfAlone } from "./helpers.js";

/** A held load: the test resolves it (with the real module) or fails it when it chooses. */
async function hold(kind: "pdf" | "journey"): Promise<void> {
  // The real module in hand first, so resolving hands back what the chunk would.
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
  // A held load nobody resolves must not fail the run.
  promise.catch(() => undefined);
  if (kind === "pdf") {
    control.holdPdf = { promise, resolve, reject };
  } else {
    control.holdJourney = { promise, resolve, reject };
  }
}

/** Lets microtasks and a macrotask run, so a resolved load has registered (or not). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function layout(id: string, name: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
  } as unknown as PdfGeneratedLayout;
}

function fullDefinition(): FormDefinition {
  const definition = sampleDefinition();
  definition.pdf = { layouts: [layout("letter", "Letter")], defaultLayout: "letter" } as NonNullable<FormDefinition["pdf"]>;
  definition.journey = {
    journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }]
  } as NonNullable<FormDefinition["journey"]>;
  return definition;
}

function create(setup?: (element: DatumFormBuilderElement) => void, definition: FormDefinition = fullDefinition()): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  setup?.(element);
  return element;
}

async function mount(setup?: (element: DatumFormBuilderElement) => void, definition?: FormDefinition): Promise<DatumFormBuilderElement> {
  const element = create(setup, definition);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
  control.holdPdf = undefined;
  control.holdJourney = undefined;
  control.pdfCalls = 0;
  control.journeyCalls = 0;
});

// Each case mounts a whole builder; a busy machine takes several seconds over one.
describe("<datum-form-builder>'s PDF and Journeys modes as chunks", { timeout: 20000 }, () => {
  it("fetches neither mode for features=\"-pdf -journeys\", and passes the definition's layouts and journeys through", async () => {
    const definition = fullDefinition();
    const element = await mount((el) => {
      el.setAttribute("features", "-pdf -journeys");
    }, definition);
    await settle();
    expect(control.pdfCalls).toBe(0);
    expect(control.journeyCalls).toBe(0);
    expect(element.pdfMode).toBeUndefined();
    expect(element.journeyMode).toBeUndefined();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(JSON.stringify(element.definition)).toBe(JSON.stringify(definition));
  });

  it("fetches neither mode for hidden Journeys and PDF workspaces, and loads each once it is shown", async () => {
    const definition = fullDefinition();
    const element = await mount((el) => el.setAttribute("hidden-workspaces", "journeys pdf"), definition);
    await settle();
    expect(control.pdfCalls).toBe(0);
    expect(control.journeyCalls).toBe(0);
    expect(element.pdfMode).toBeUndefined();
    expect(element.journeyMode).toBeUndefined();
    expect(JSON.stringify(element.definition)).toBe(JSON.stringify(definition));

    element.setAttribute("hidden-workspaces", "journeys");
    await until(() => element.pdfMode !== undefined);
    expect(control.journeyCalls).toBe(0);
    expect(element.builder!.availableWorkspaces()).toContain("pdf");
    element.removeAttribute("hidden-workspaces");
    await until(() => element.journeyMode !== undefined);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    expect(JSON.stringify(element.definition)).toBe(JSON.stringify(definition));
  });

  it("keeps the definition byte for byte while a mode is coming, and after it registers", async () => {
    await hold("pdf");
    await hold("journey");
    const definition = fullDefinition();
    const element = await mount(undefined, definition);
    expect(control.pdfCalls).toBe(1);
    expect(control.journeyCalls).toBe(1);
    expect(element.pdfMode).toBeUndefined();
    expect(element.journeyMode).toBeUndefined();
    expect(element.journeyConfiguration).toBe(definition.journey);
    expect(element.pdfConfiguration).toBe(definition.pdf);
    expect(JSON.stringify(element.definition)).toBe(JSON.stringify(definition));
    expect(element.dirty).toBe(false);

    // Journeys first: the PDF side still takes its place ahead of them on the bar.
    control.holdJourney!.resolve();
    await until(() => element.journeyMode !== undefined);
    control.holdPdf!.resolve();
    await until(() => element.pdfMode !== undefined);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    expect(JSON.stringify(element.definition)).toBe(JSON.stringify(definition));
    expect(element.dirty).toBe(false);
  });

  it("registers nothing when the side goes off while its mode is coming, and once when it comes back on", async () => {
    await hold("pdf");
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    expect(control.pdfCalls).toBe(1);
    element.setAttribute("features", "-pdf -journeys");
    await settle();
    control.holdPdf!.resolve();
    await settle();
    expect(element.pdfMode).toBeUndefined();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);

    // Back on: one more ask, one mode.
    element.setAttribute("features", "-journeys");
    await until(() => element.pdfMode !== undefined);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
  });

  it("registers one mode when the side is applied again while its chunk is coming", async () => {
    await hold("pdf");
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    // Another pdf-* change re-applies the side mid-load.
    element.setAttribute("pdf-theme", "default");
    await settle();
    expect(control.pdfCalls).toBe(2);
    control.holdPdf!.resolve();
    await until(() => element.pdfMode !== undefined);
    await settle();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
  });

  it("registers a mode whose chunk came while the element was off the page on the next connect", async () => {
    await hold("journey");
    const element = await mount((el) => el.setAttribute("features", "-pdf"));
    element.remove();
    control.holdJourney!.resolve();
    await settle();
    expect(element.journeyMode).toBeUndefined();
    control.holdJourney = undefined;
    document.body.append(element);
    await until(() => element.journeyMode !== undefined);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "journeys"]);
  });

  it("enters the PDF workspace asked for while the mode was coming, once it registers", async () => {
    await hold("pdf");
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    expect(element.builder!.availableWorkspaces()).not.toContain("pdf");
    expect(element.setWorkspace("pdf")).toBe(true);
    control.holdPdf!.resolve();
    await until(() => element.builder!.workspace === "pdf");
    expect(element.workspace).toBe("pdf");
  });

  it("follows a workspace the author chose meanwhile over the one asked for", async () => {
    await hold("pdf");
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    element.setWorkspace("pdf");
    element.setWorkspace("logic");
    control.holdPdf!.resolve();
    await until(() => element.pdfMode !== undefined);
    await settle();
    expect(element.builder!.workspace).toBe("logic");
  });

  it("puts the side `mode` names on the page once its mode registers", async () => {
    await hold("journey");
    const element = await mount((el) => {
      el.setAttribute("features", "-pdf");
      el.setAttribute("mode", "journeys");
    });
    expect(element.builder!.mode).toBe("form");
    control.holdJourney!.resolve();
    await until(() => element.builder!.mode === "journeys");
  });

  it("reports a failed load and tries again on the next apply", async () => {
    await hold("pdf");
    const errors: string[] = [];
    const element = create((el) => el.setAttribute("features", "-journeys"));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(element);
    control.holdPdf!.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("The PDF side could not be loaded");
    expect(element.pdfMode).toBeUndefined();
    control.holdPdf = undefined;
    element.setAttribute("pdf-theme", "default");
    await until(() => element.pdfMode !== undefined);
  });

  // --- absent-code resilience and renames while a mode is not registered ---------

  it("shows a failed Journeys load inline with Retry, keeps the form working, and registers on Retry", async () => {
    await hold("journey");
    const errors: Array<{ message: string; cause: unknown }> = [];
    const element = create((el) => el.setAttribute("features", "-pdf"));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const cause = new Error("journeys chunk missing");
    control.holdJourney!.reject(cause);
    await until(() => errors.length > 0);
    expect(errors[0]).toEqual({ code: "file.unavailable", message: "The Journeys side could not be loaded", cause });
    const card = element.shadowRoot!.querySelector<HTMLElement>('[data-mode-failed="journeys"]');
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("The journeys didn't load.");
    expect(element.shadowRoot!.querySelector<HTMLElement>("[data-mode-status]")!.hidden).toBe(false);
    // The rest of the builder works on: the form side, its definition, a workspace switch.
    expect(element.journeyMode).toBeUndefined();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(element.builder!.hidden).toBe(false);
    expect(element.setWorkspace("logic")).toBe(true);
    expect(element.definition.journey).toEqual(fullDefinition().journey);

    control.holdJourney = undefined;
    card!.querySelector<HTMLButtonElement>('[data-mode-retry="journeys"]')!.click();
    await until(() => element.journeyMode !== undefined);
    expect(element.shadowRoot!.querySelector('[data-mode-failed="journeys"]')).toBeNull();
    expect(element.shadowRoot!.querySelector<HTMLElement>("[data-mode-status]")!.hidden).toBe(true);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "journeys"]);
  });

  it("tries a failed load again when the element is connected again", async () => {
    await hold("pdf");
    const errors: string[] = [];
    const element = create((el) => el.setAttribute("features", "-journeys"));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(element);
    control.holdPdf!.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    expect(element.shadowRoot!.querySelector('[data-mode-failed="pdf"]')).not.toBeNull();
    element.remove();
    control.holdPdf = undefined;
    await settle();
    // Nothing tries again while the element is off the page; connecting it does.
    expect(element.pdfMode).toBeUndefined();
    document.body.append(element);
    await until(() => element.pdfMode !== undefined);
    expect(element.shadowRoot!.querySelector('[data-mode-failed="pdf"]')).toBeNull();
  });

  it("reports a mode that throws as it registers, with no unhandled rejection", async () => {
    let fail = true;
    const actual = (await vi.importActual("../../../engine/form-engine/builder/pdf-designer/pdf-builder-mode.ts")) as Record<string, unknown>;
    const throwing = {
      ...actual,
      createPdfBuilderMode: (...args: unknown[]) => {
        if (fail) {
          throw new Error("mode could not be built");
        }
        return (actual.createPdfBuilderMode as (...a: unknown[]) => unknown)(...args);
      }
    };
    control.holdPdf = { promise: Promise.resolve(throwing), resolve: () => undefined, reject: () => undefined };
    const errors: string[] = [];
    const element = create((el) => el.setAttribute("features", "-journeys"));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(element);
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("The PDF side could not be loaded");
    expect(element.pdfMode).toBeUndefined();
    expect(element.shadowRoot!.querySelector('[data-mode-failed="pdf"]')).not.toBeNull();
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    fail = false;
    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-mode-retry="pdf"]')!.click();
    await until(() => element.pdfMode !== undefined);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf"]);
  });

  it("enters the workspace asked for while the mode was coming when its chunk came while off the page", async () => {
    await hold("pdf");
    const element = await mount((el) => el.setAttribute("features", "-journeys"));
    expect(element.setWorkspace("pdf")).toBe(true);
    element.remove();
    control.holdPdf!.resolve();
    await settle();
    expect(element.pdfMode).toBeUndefined();
    control.holdPdf = undefined;
    document.body.append(element);
    await until(() => element.builder!.workspace === "pdf");
    expect(element.workspace).toBe("pdf");
  });

  it("drops a side asked for while its chunk was coming once the author moves elsewhere", async () => {
    await hold("journey");
    const element = await mount((el) => el.setAttribute("features", "-pdf"));
    expect(element.setMode("journeys")).toBe(true);
    // The author opens Logic meanwhile: the chunk's arrival must not pull them off it.
    element.builder!.setWorkspace("logic");
    await until(() => element.builder!.workspace === "logic");
    control.holdJourney!.resolve();
    await until(() => element.journeyMode !== undefined);
    await settle();
    expect(element.builder!.workspace).toBe("logic");
    expect(element.builder!.mode).toBe("form");
  });

  it("follows a rename made while the modes are coming into the layouts and journeys they then register with", async () => {
    await hold("pdf");
    await hold("journey");
    const definition = fullDefinition();
    (definition.pdf!.layouts![0]! as { when?: unknown }).when = "fullName";
    const element = await mount(undefined, definition);
    const changes: Array<{ mode: string; reason: string }> = [];
    element.addEventListener("datum-builder-change", (event) => changes.push((event as CustomEvent<{ mode: string; reason: string }>).detail));
    element.controller!.renameId("fullName", "applicantName");
    await until(() => changes.some((change) => change.mode === "journeys"));
    expect(changes.map((change) => `${change.mode}:${change.reason}`)).toEqual(expect.arrayContaining(["pdf:layouts", "journeys:form-rename"]));
    expect(element.definition.journey!.journeys![0]!.pages[0]!.components).toEqual(["applicantName"]);
    expect((element.definition.pdf!.layouts![0]! as { when?: unknown }).when).toBe("applicantName");
    const renamed = JSON.stringify(element.definition);

    control.holdJourney!.resolve();
    control.holdPdf!.resolve();
    await until(() => element.pdfMode !== undefined && element.journeyMode !== undefined);
    // The modes register over the seed as renamed: the definition reads back the same.
    expect(element.journeyMode!.journeyConfiguration!.journeys![0]!.pages[0]!.components).toEqual(["applicantName"]);
    expect(JSON.stringify(element.definition)).toBe(renamed);
    expect(renamed).not.toContain('"fullName"');
  });

  it("follows a rename into the journeys and layouts of sides that are off or hidden", async () => {
    const definition = fullDefinition();
    (definition.pdf!.layouts![0]! as { when?: unknown }).when = "fullName";
    const element = await mount((el) => {
      el.setAttribute("features", "-journeys");
      el.setAttribute("hidden-workspaces", "pdf");
    }, definition);
    await settle();
    expect(control.pdfCalls + control.journeyCalls).toBe(0);
    const journeyChanges: string[] = [];
    element.addEventListener("datum-journey-change", (event) => journeyChanges.push((event as CustomEvent<{ reason: string }>).detail.reason));
    element.controller!.renameId("fullName", "applicantName");
    await until(() => journeyChanges.length > 0);
    expect(journeyChanges).toEqual(["form-rename"]);
    expect(element.definition.journey!.journeys![0]!.pages[0]!.components).toEqual(["applicantName"]);
    expect((element.definition.pdf!.layouts![0]! as { when?: unknown }).when).toBe("applicantName");
    expect(control.pdfCalls + control.journeyCalls).toBe(0);
    // Round trip: the definition as read back seeds an element that reads it back the same.
    const saved = JSON.stringify(element.definition);
    element.definition = JSON.parse(saved) as FormDefinition;
    await settle();
    expect(JSON.stringify(element.definition)).toBe(saved);
  });

  it("follows a rename made after a failed load, and the retried mode registers with it", async () => {
    await hold("journey");
    const errors: string[] = [];
    const element = create((el) => el.setAttribute("features", "-pdf"));
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    control.holdJourney!.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    element.controller!.renameId("fullName", "applicantName");
    await settle();
    expect(element.definition.journey!.journeys![0]!.pages[0]!.components).toEqual(["applicantName"]);
    control.holdJourney = undefined;
    element.shadowRoot!.querySelector<HTMLButtonElement>('[data-mode-retry="journeys"]')!.click();
    await until(() => element.journeyMode !== undefined);
    expect(element.journeyMode!.journeyConfiguration!.journeys![0]!.pages[0]!.components).toEqual(["applicantName"]);
  });

  it("registers at once on a page that already has the modes", async () => {
    const first = await mount();
    await modesReady(first);
    const calls = control.pdfCalls + control.journeyCalls;
    const second = create();
    document.body.append(second);
    expect(second.pdfMode).toBeDefined();
    expect(second.journeyMode).toBeDefined();
    expect(control.pdfCalls + control.journeyCalls).toBe(calls);
  });
});

describe("the PDF layouts alone (workspaces=\"pdf\") while the PDF mode's chunk loads or fails", { timeout: 20000 }, () => {
  it("shows a loading card instead of the form editor, then the failure card with Retry; there is no pdfMode meanwhile", async () => {
    await hold("pdf");
    const errors: string[] = [];
    const element = pdfAlone();
    element.definition = fullDefinition();
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(element);
    await until(() => element.builder !== undefined);
    const status = (): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-mode-status]")!;
    // Loading: no form editor, a status card.
    expect(element.builder!.hidden).toBe(true);
    expect(status().hidden).toBe(false);
    expect(status().querySelector('[data-mode-loading="pdf"]')?.getAttribute("role")).toBe("status");
    // Nothing to drive meanwhile: the mode is the API, and it is not there yet.
    expect(element.pdfMode).toBeUndefined();

    control.holdPdf!.reject(new Error("chunk missing"));
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("The PDF side could not be loaded");
    expect(element.builder!.hidden).toBe(true);
    expect(status().querySelector('[data-mode-loading="pdf"]')).toBeNull();
    const card = status().querySelector<HTMLElement>('[data-mode-failed="pdf"]');
    expect(card?.getAttribute("role")).toBe("alert");
    expect(card?.textContent).toContain("The layouts didn't load.");
    expect(element.pdfMode).toBeUndefined();

    control.holdPdf = undefined;
    card!.querySelector<HTMLButtonElement>('[data-mode-retry="pdf"]')!.click();
    await until(() => element.pdfMode !== undefined);
    await until(() => element.builder!.mode === "pdf");
    expect(element.builder!.hidden).toBe(false);
    expect(status().hidden).toBe(true);
  });
});
