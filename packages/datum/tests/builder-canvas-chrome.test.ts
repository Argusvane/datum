import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { BuilderController, DatumBuilderElement, type BuilderMode, type BuilderModeContext, type ComponentNode } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, PdfGeneratedLayout, PdfRenderProvider } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/*
 * The canvas keeps its bar for a fixed sheet and a surface: a fixed sheet gives up
 * only the device widths, a surface says for itself whether the zoom tools and Try it apply, and
 * a fixed sheet wider than the canvas fits itself until the author chooses a zoom. jsdom has no
 * layout, so the fit is driven through the canvas's measure seam.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

interface Canvas extends HTMLElement {
  zoom: number;
  previewing: boolean;
  previewRoot(): ShadowRoot | undefined;
  zoomTo(value: number | "fit" | "fit-width"): void;
  measureFit: () => { sheetWidth: number; sheetHeight: number; roomWidth: number; roomHeight: number };
  fitIfOverflowing(): void;
  showSurface(surface: HTMLElement | undefined, styles?: string, options?: { zoom?: (to: number | "fit") => void; zoomable?: boolean; tryable?: boolean }): void;
}

function generated(id: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name: id,
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: `${id}-field`, type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
    }
  };
}

const provider = (): PdfRenderProvider =>
  ({
    id: "fake",
    abiVersion: "1.0.0",
    render: async () => ({ bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
    inspect: async () => ({ pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: [], hasXfa: false, encrypted: false })
  }) as unknown as PdfRenderProvider;

const canvasOf = (element: DatumFormBuilderElement): Canvas => element.builder!.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;

async function onPdf(): Promise<{ element: DatumFormBuilderElement; canvas: Canvas; root: ShadowRoot }> {
  const element = document.createElement("datum-form-builder");
  element.definition = { ...sampleDefinition(), pdf: { layouts: [generated("letter"), generated("a4")] } } as FormDefinition;
  element.pdfSupport = { provider: provider() };
  document.body.append(element);
  await until(() => element.pdfMode !== undefined);
  element.mode = "pdf";
  await until(() => element.mode === "pdf" && element.pdfMode?.ready);
  const canvas = canvasOf(element);
  await until(() => canvas.shadowRoot?.querySelector(".canvas-surface[data-sheet-fixed]"));
  return { element, canvas, root: canvas.shadowRoot! };
}

describe("the canvas bar on a PDF layout", () => {
  it("shows the bar with zoom and Try it but no device widths, and the zoom buttons work", async () => {
    const { canvas, root } = await onPdf();
    expect(root.querySelector<HTMLElement>("[data-canvas-bar-zone]")!.hidden).toBe(false);
    expect(root.querySelector(".panel--canvas")!.hasAttribute("data-canvas-bar-shown")).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-canvas-devices]")!.hidden).toBe(true);
    const tryIt = root.querySelector<HTMLElement>("[data-try-it]")!;
    expect(tryIt).not.toBeNull();
    expect(tryIt.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(false);
    root.querySelector<HTMLElement>('[data-canvas-zoom-go="out"]')!.click();
    expect(canvas.zoom).toBeLessThan(1);
    root.querySelector<HTMLElement>('[data-canvas-zoom-go="actual"]')!.click();
    expect(canvas.zoom).toBe(1);
  });

  it("shows the selection bar for a selected component", async () => {
    const { element, root } = await onPdf();
    element.pdfMode!.controller.select("letter-field");
    await until(() => root.querySelector<HTMLElement>("[data-selection-zone]")!.hidden === false);
  });

  it("fits a sheet wider than the canvas until the author chooses a zoom", async () => {
    const { canvas, root } = await onPdf();
    canvas.measureFit = () => ({ sheetWidth: 816, sheetHeight: 1056, roomWidth: 600, roomHeight: 900 });
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBeCloseTo(600 / 816, 2);
    // More room later: the auto-fit lets go of its zoom.
    canvas.measureFit = () => ({ sheetWidth: 816, sheetHeight: 1056, roomWidth: 1000, roomHeight: 900 });
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBe(1);
    canvas.measureFit = () => ({ sheetWidth: 816, sheetHeight: 1056, roomWidth: 600, roomHeight: 900 });
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBeLessThan(1);
    // The author zooms: the next resize leaves it alone.
    root.querySelector<HTMLElement>('[data-canvas-zoom-go="in"]')!.click();
    const chosen = canvas.zoom;
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBe(chosen);
  });
});

describe("a surface on the canvas", () => {
  const root: ComponentNode = { id: "root", type: "form", configuration: { title: "Sample" }, children: { content: [] } };

  it("hides the zoom tools for a surface that says it is not zoomable, and Try it unless it opts in", async () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: root };
    document.body.append(element);
    await until(() => (element.shadowRoot?.querySelector("datum-builder-canvas") as Canvas | null)?.shadowRoot?.querySelector(".canvas-page"));
    const canvas = element.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
    const shadow = canvas.shadowRoot!;
    expect(shadow.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(false);
    canvas.showSurface(document.createElement("div"), undefined, { zoomable: false, tryable: true });
    expect(shadow.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>("[data-canvas-bar-zone]")!.hidden).toBe(false);
    canvas.showSurface(document.createElement("div"), undefined, { tryable: false });
    expect(shadow.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(true);
    // A zoomable surface is driven by the bar's tools.
    const seen: Array<number | "fit"> = [];
    canvas.showSurface(document.createElement("div"), undefined, { zoomable: true, zoom: (to) => seen.push(to) });
    expect(shadow.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(false);
    shadow.querySelector<HTMLElement>('[data-canvas-zoom-go="in"]')!.click();
    shadow.querySelector<HTMLElement>('[data-canvas-zoom-go="fit"]')!.click();
    // The new surface was told to start fitted; then + and Fit.
    expect(seen[0]).toBe("fit");
    expect(seen[1]).toBeGreaterThan(1);
    expect(seen[2]).toBe("fit");
    canvas.showSurface(undefined);
    expect(shadow.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(false);
  });

  it("draws a journey's sheet without data-sheet-fixed: the Form sheet rule", async () => {
    const definition = sampleDefinition();
    definition.journey = {
      journeys: [{ id: "apply", name: "Apply online", pages: [{ id: "p1", components: ["fullName"] }] }]
    } as NonNullable<FormDefinition["journey"]>;
    const element = document.createElement("datum-form-builder");
    element.definition = definition;
    document.body.append(element);
    await until(() => canvasOf(element));
    element.mode = "journeys";
    // A journey opens on its map, even with one step; the Step view is the form's sheet with the step's own buttons.
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    element.journeyMode!.view = "step";
    await until(() => canvasOf(element).previewRoot?.()?.querySelector("[data-journey-continue]"));
    expect(element.journeyMode!.view).toBe("step");
    const surface = canvasOf(element).shadowRoot!.querySelector(".canvas-surface")!;
    expect(surface.hasAttribute("data-sheet-fixed")).toBe(false);
    // The bar for journeys: zoom and Try it, no device widths and no drag grips.
    expect(canvasOf(element).shadowRoot!.querySelector<HTMLElement>("[data-canvas-devices]")!.hidden).toBe(true);
    for (const grip of surface.querySelectorAll<HTMLElement>("[data-sheet-grip]")) {
      expect(grip.hidden).toBe(true);
    }
    expect(canvasOf(element).shadowRoot!.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(false);
  });
});

const OVERFLOW = { sheetWidth: 816, sheetHeight: 1056, roomWidth: 600, roomHeight: 900 };

describe("the auto-fit of a fixed sheet", () => {
  it("fits on first show through the paint, and again for another layout after the author zoomed", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = { ...sampleDefinition(), pdf: { layouts: [generated("letter"), generated("a4")] } } as FormDefinition;
    element.pdfSupport = { provider: provider() };
    document.body.append(element);
    await until(() => canvasOf(element)?.shadowRoot?.querySelector(".canvas-page"));
    const canvas = canvasOf(element);
    // Stubbed before the PDF controller is set: nothing here calls fitIfOverflowing by hand.
    canvas.measureFit = () => OVERFLOW;
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    await until(() => canvas.zoom < 1);
    expect(canvas.zoom).toBeCloseTo(600 / 816, 2);

    // The author zooms; another layout is the author's to zoom afresh, so it fits again.
    canvas.shadowRoot!.querySelector<HTMLElement>('[data-canvas-zoom-go="actual"]')!.click();
    expect(canvas.zoom).toBe(1);
    await element.pdfMode!.selectLayout("a4");
    await until(() => element.pdfMode!.layoutId === "a4" && element.pdfMode!.ready);
    await until(() => canvas.zoom < 1);
  });

  it("keeps the page's scroll and pan on a refit that changes nothing, and an explicit Fit is not undone", async () => {
    const { canvas, root } = await onPdf();
    canvas.measureFit = () => OVERFLOW;
    canvas.fitIfOverflowing();
    const fitted = canvas.zoom;
    expect(fitted).toBeLessThan(1);
    const page = root.querySelector<HTMLElement>(".canvas-page")!;
    const writes: number[] = [];
    Object.defineProperty(page, "scrollTop", { configurable: true, get: () => 40, set: (value: number) => void writes.push(value) });
    canvas.fitIfOverflowing();
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBe(fitted);
    expect(writes).toEqual([]);
    // A selection (a padding change) repaints; nothing scrolls to the top either.
    canvas.measureFit = () => ({ ...OVERFLOW, roomWidth: 700 });
    canvas.fitIfOverflowing();
    expect(writes).toEqual([]);
    // Fit by the author: whole-page, and the next resize leaves it.
    canvas.zoomTo("fit");
    const afterFit = canvas.zoom;
    canvas.measureFit = () => ({ ...OVERFLOW, roomWidth: 1000 });
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBe(afterFit);
  });

  it("models the real sequence: the page is sized before the sheet is painted, and the observer's callback fits it", async () => {
    // The observer as Chrome runs it: a callback once at attach (nothing painted yet, widths 0), another on a resize.
    const callbacks: Array<() => void> = [];
    const global = globalThis as unknown as { ResizeObserver?: unknown };
    global.ResizeObserver = class {
      public constructor(callback: () => void) {
        callbacks.push(callback);
      }
      public observe(): void {}
      public unobserve(): void {}
      public disconnect(): void {}
    };
    try {
      const { canvas } = await onPdf();
      // Unpainted: no widths, nothing to fit, and nothing used up either.
      canvas.measureFit = () => ({ sheetWidth: 0, sheetHeight: 0, roomWidth: 600, roomHeight: 900 });
      callbacks.forEach((callback) => callback());
      expect(canvas.zoom).toBe(1);
      // Painted: the next callback fits.
      canvas.measureFit = () => OVERFLOW;
      callbacks.forEach((callback) => callback());
      expect(canvas.zoom).toBeCloseTo(600 / 816, 2);
    } finally {
      delete global.ResizeObserver;
    }
  });

  it("fits a fixed sheet when a surface gives way to it", async () => {
    const { canvas } = await onPdf();
    canvas.measureFit = () => OVERFLOW;
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBeLessThan(1);
    // A template viewer (or the empty state) on the page, then the layout's paper again: fitted afresh.
    canvas.showSurface(document.createElement("div"), undefined, { zoomable: true });
    canvas.showSurface(undefined);
    expect(canvas.zoom).toBeCloseTo(600 / 816, 2);
  });

  it("never fits the Form sheet", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => canvasOf(element)?.shadowRoot?.querySelector(".canvas-surface"));
    const canvas = canvasOf(element);
    canvas.measureFit = () => OVERFLOW;
    canvas.fitIfOverflowing();
    expect(canvas.zoom).toBe(1);
  });
});

describe("surfaces through the shell", () => {
  function notesMode(): BuilderMode & { context: BuilderModeContext | undefined } {
    const controller = new BuilderController();
    controller.setOptions({ initialRoot: { id: "notes-root", type: "form", configuration: { title: "Notes" }, children: { content: [] } }, componentTypes: [{ type: "text", label: "Note" }] });
    const mode: BuilderMode & { context: BuilderModeContext | undefined } = {
      id: "notes",
      label: "Notes",
      controller,
      context: undefined,
      activate: async (context) => {
        mode.context = context;
      }
    };
    return mode;
  }

  async function withNotes(): Promise<{ mode: ReturnType<typeof notesMode>; shadow: ShadowRoot; canvas: Canvas }> {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = { initialRoot: { id: "root", type: "form", configuration: { title: "Sample" }, children: { content: [] } } };
    document.body.append(element);
    await until(() => (element.shadowRoot?.querySelector("datum-builder-canvas") as Canvas | null)?.shadowRoot?.querySelector(".canvas-page"));
    const mode = notesMode();
    element.addMode(mode);
    element.setMode("notes");
    await until(() => element.mode === "notes" && mode.context);
    const canvas = element.shadowRoot!.querySelector("datum-builder-canvas") as Canvas;
    return { mode, shadow: canvas.shadowRoot!, canvas };
  }

  it("drives a zoomable surface's own zoom from the bar's buttons, up to its own maximum", async () => {
    const { mode, shadow } = await withNotes();
    const seen: Array<number | "fit"> = [];
    mode.context!.showCanvasSurface(document.createElement("div"), { zoom: (to) => seen.push(to), zoomable: true });
    // A new surface is told to start fitted.
    expect(seen).toEqual(["fit"]);
    const into = shadow.querySelector<HTMLButtonElement>('[data-canvas-zoom-go="in"]')!;
    for (let i = 0; i < 8; i += 1) {
      into.click();
    }
    expect(Math.max(...seen.filter((to): to is number => typeof to === "number"))).toBeGreaterThan(2);
    expect(shadow.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(false);
    expect(shadow.querySelector<HTMLElement>("[data-canvas-more]")!.hidden).toBe(false);
  });

  it("hides the zoom tools, the folded tools button and Try it for a map-like surface", async () => {
    const { mode, shadow } = await withNotes();
    mode.context!.showCanvasSurface(document.createElement("div"), { zoomable: false });
    expect(shadow.querySelector<HTMLElement>("[data-canvas-zoom]")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>("[data-canvas-devices]")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>("[data-canvas-more]")!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(true);
    mode.context!.showCanvasSurface(document.createElement("div"), { tryable: true });
    expect(shadow.querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(false);
  });

  it("ends trying when a surface that cannot be tried arrives, so Back to editing never hides", async () => {
    const { mode, shadow, canvas } = await withNotes();
    canvas.previewing = true;
    const tryIt = shadow.querySelector<HTMLElement>("[data-try-it]")!;
    expect(tryIt.hidden).toBe(false);
    mode.context!.showCanvasSurface(document.createElement("div"));
    expect(canvas.previewing).toBe(false);
    expect(tryIt.hidden).toBe(true);
    expect(tryIt.textContent).toBe("Try it");
  });
});
