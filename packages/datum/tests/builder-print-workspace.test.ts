import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Print workspace through `<datum-form-builder>`: its chunk is fetched on the
 * first visit only; the card writes the form's print settings through the controller (one undo
 * step each) and keeps the box being typed in; the samples and the receipt are the session's,
 * never the form's; the sheet is the renderer's own print document for the version chosen; a
 * click on it opens the component's "On paper" fields; "Print a test page" goes through the
 * renderer's print(). jsdom lays nothing out: the sheet's measure is stubbed (`measurePreview`).
 */
const { asked } = vi.hoisted(() => ({ asked: { print: 0 } }));

vi.mock("../../../engine/form-engine/builder/print/print-loader.ts", async (importOriginal) => {
  const actual = await importOriginal<{ loadPrintSurface(): Promise<unknown> }>();
  return {
    ...actual,
    loadPrintSurface: () => {
      asked.print += 1;
      return actual.loadPrintSurface();
    }
  };
});

import "../src/builder.js";
import { BuilderPreviewRuntime, addressOf, type FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumBuilderPrintElement } from "../../../engine/form-engine/builder/print/print-surface.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

beforeEach(() => {
  asked.print = 0;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(setup?: (element: DatumFormBuilderElement) => void, definition: FormDefinition = sampleDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = definition;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const surfaceOf = (element: DatumFormBuilderElement): DatumBuilderPrintElement | null => shell(element).querySelector("datum-builder-print") as DatumBuilderPrintElement | null;

/** A measure with two blocks: the first page full, the second component past its foot. */
const MEASURE = (): { height: number; blocks: Array<{ top: number; height: number; componentId?: string }> } => ({
  height: 1600,
  blocks: [
    { top: 0, height: 900, componentId: "fullName" },
    { top: 900, height: 120, componentId: "country" }
  ]
});

/** Opens Print, stubs the measure, and waits for the first sheet. */
async function openPrint(element: DatumFormBuilderElement): Promise<{ surface: DatumBuilderPrintElement; root: ShadowRoot }> {
  element.builder!.setWorkspace("print");
  await until(() => surfaceOf(element)?.shadowRoot?.querySelector("[data-print-settings] h2"));
  const surface = surfaceOf(element)!;
  surface.measurePreview = MEASURE;
  await until(() => surface.prepared !== undefined);
  await surface.previewSettled();
  return { surface, root: surface.shadowRoot! };
}

const printBlock = (element: DatumFormBuilderElement): Record<string, unknown> | undefined =>
  (element.definition.root.configuration as { print?: Record<string, unknown> } | undefined)?.print;

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** Opens `slot`'s Insert menu by its button and presses the item for `choice`. */
function insertFromMenu(root: ShadowRoot, slot: string, choice: string): void {
  root.querySelector<HTMLButtonElement>(`button[data-print-insert="${slot}"]`)!.click();
  root.querySelector<HTMLButtonElement>(`[data-print-insert-item="${slot}|${choice}"]`)!.click();
}

const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe("the Print workspace", () => {
  it("is a workspace after PDF whose chunk is fetched on the first visit only", async () => {
    const element = await mount();
    const builder = element.builder!;
    expect(builder.availableWorkspaces()).toContain("print");
    expect(builder.availableWorkspaces().at(-1)).toBe("print");
    expect(asked.print).toBe(0);
    await openPrint(element);
    expect(asked.print).toBe(1);
    // The canvas and the inspector step aside; the Variables panel is offered, reading placeholders.
    expect(shell(element).querySelector("[data-print-host]")!.hasAttribute("hidden")).toBe(false);
    expect(shell(element).querySelector('[data-strip] [data-panel="variables"]')!.hasAttribute("data-out-of-workspace")).toBe(false);
    builder.setWorkspace("form");
    await until(() => builder.workspace === "form");
    builder.setWorkspace("print");
    await until(() => builder.workspace === "print");
    expect(asked.print).toBe(1);
    expect(surfaceOf(element)).not.toBeNull();
  });

  it("writes the card's settings into the definition, each one undo step", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const blank = root.querySelector<HTMLInputElement>('[data-print-rendition="blank"]')!;
    blank.checked = true;
    blank.dispatchEvent(new Event("change", { bubbles: true }));
    expect(printBlock(element)?.renditions).toEqual(["answers", "blank"]);
    // The default is offered among the ticked ones only.
    await until(() => root.querySelectorAll("[data-print-default] option").length === 2);
    const title = root.querySelector<HTMLInputElement>("[data-print-title-first]")!;
    title.checked = false;
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect(printBlock(element)?.titleOnFirstPage).toBe(false);
    element.controller!.undo();
    expect(printBlock(element)?.titleOnFirstPage).toBeUndefined();
    expect(printBlock(element)?.renditions).toEqual(["answers", "blank"]);
    element.controller!.undo();
    expect(printBlock(element)?.renditions).toBeUndefined();
    // The last offered version stays: its box cannot be unticked.
    await until(() => root.querySelector<HTMLInputElement>('[data-print-rendition="answers"]')?.disabled === true);
  });

  it("keeps the slot box's focus and caret while the typed text is written, and resets a slot to its default", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const box = (): HTMLInputElement => root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    // A slot the form says nothing about shows what prints there: the header's end prints nothing.
    expect(box().value).toBe("");
    expect(root.querySelector<HTMLInputElement>('[data-print-slot="footer.end"]')!.value).toBe("Page {{page}} of {{pages}}");
    expect(root.querySelector<HTMLElement>('[data-print-slot-reset="header.end"]')!.hidden).toBe(true);
    const input = box();
    typeInto(input, "Ref {{receipt.reference}}");
    input.setSelectionRange(3, 3);
    await until(() => (printBlock(element)?.header as { end?: string } | undefined)?.end === "Ref {{receipt.reference}}", 3000);
    await surface.previewSettled();
    // The same box, still focused, its caret where it was.
    expect(box()).toBe(input);
    expect(root.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
    expect(root.querySelector<HTMLElement>('[data-print-slot-reset="header.end"]')!.hidden).toBe(false);
    // An insert shortcut puts its placeholder at the caret.
    insertFromMenu(root, "header.end", "date");
    expect((printBlock(element)?.header as { end?: string }).end).toBe("Ref {{date}} {{receipt.reference}}");
    root.querySelector<HTMLButtonElement>('[data-print-slot-reset="header.end"]')!.click();
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBeUndefined();
    expect(box().value).toBe("");
    expect(root.querySelector<HTMLElement>('[data-print-slot-reset="header.end"]')!.hidden).toBe(true);
  });

  it("keeps the samples and the receipt out of the definition and the history", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const before = JSON.stringify(element.definition);
    const undoable = element.controller!.canUndo();
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = "pasted";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    const pasted = root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")!;
    typeInto(pasted, "{ not json");
    await until(() => root.querySelector<HTMLElement>("[data-print-pasted-error]")!.hidden === false);
    expect(root.querySelector("[data-print-pasted-error]")!.textContent).toBe("That is not JSON.");
    // A submission envelope: its answers are drawn.
    typeInto(pasted, JSON.stringify({ versionContext: {}, submission: { locale: "en", values: { fullName: "Ada Lovelace" } } }));
    typeInto(root.querySelector<HTMLTextAreaElement>("[data-print-receipt]")!, JSON.stringify({ reference: "CG-2026-00418" }));
    await pause(300);
    await surface.previewSettled();
    expect(root.querySelector<HTMLElement>("[data-print-pasted-error]")!.hidden).toBe(true);
    expect(surface.prepared!.html).toContain("Ada Lovelace");
    expect(surface.previewRenderer!.notice).toEqual({ data: { reference: "CG-2026-00418" } });
    expect(JSON.stringify(element.definition)).toBe(before);
    expect(element.controller!.canUndo()).toBe(undoable);
  });

  it("shows the sample boxes only when asked for, keeps their text across, and marks a receipt that is set", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const samples = root.querySelector<HTMLElement>("[data-print-samples]")!;
    const pastedField = root.querySelector<HTMLElement>("[data-print-pasted-field]")!;
    const receiptField = root.querySelector<HTMLElement>("[data-print-receipt-field]")!;
    const toggle = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>("[data-print-receipt-toggle]")!;
    // Neither box is up until asked for.
    expect(samples.hidden).toBe(true);
    expect(pastedField.hidden).toBe(true);
    expect(receiptField.hidden).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector("[data-print-receipt-set]")).toBeNull();
    // The boxes open in the Preview card beside the settings, not over the sheet.
    expect(root.querySelector("[data-print-preview] [data-print-samples]")).not.toBeNull();
    expect(root.querySelector("[data-print-scroller] [data-print-samples]")).toBeNull();
    // The receipt's box is behind the Preview card's button.
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(samples.hidden).toBe(false);
    expect(receiptField.hidden).toBe(false);
    expect(pastedField.hidden).toBe(true);
    const receipt = root.querySelector<HTMLTextAreaElement>("[data-print-receipt]")!;
    typeInto(receipt, JSON.stringify({ reference: "CG-1" }));
    expect(root.querySelector("[data-print-receipt-set]")).not.toBeNull();
    toggle().click();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(samples.hidden).toBe(true);
    // Hidden, the receipt is still the sample's: the badge stays, and so does the text.
    expect(root.querySelector("[data-print-receipt-set]")).not.toBeNull();
    toggle().click();
    expect(root.querySelector<HTMLTextAreaElement>("[data-print-receipt]")!.value).toBe(JSON.stringify({ reference: "CG-1" }));
    // The submission's box shows for a pasted sample only, and keeps its text when the picker moves away.
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = "pasted";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    expect(pastedField.hidden).toBe(false);
    typeInto(root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")!, JSON.stringify({ fullName: "Ada" }));
    sample.value = "none";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    expect(pastedField.hidden).toBe(true);
    expect(samples.hidden).toBe(false);
    sample.value = "pasted";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")!.value).toBe(JSON.stringify({ fullName: "Ada" }));
    await surface.previewSettled();
    expect(surface.prepared!.html).toContain("Ada");
    // The scroller is keyboard-scrollable and named.
    const scroller = root.querySelector<HTMLElement>("[data-print-scroller]")!;
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(scroller.getAttribute("aria-label")).toBe("Preview of the printed form");
  });

  it("asks the renderer for the version chosen, and prints a test page through print() with it", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const renderer = surface.previewRenderer!;
    const prepare = vi.spyOn(renderer, "preparePrintDocument");
    root.querySelector<HTMLButtonElement>('[data-print-version="blank"]')!.click();
    await pause(10);
    await surface.previewSettled();
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ rendition: "blank", page: { size: "letter" } }));
    expect(root.querySelector('[data-print-version="blank"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(surface.prepared!.model.rendition).toBe("blank");
    const print = vi.spyOn(renderer, "print").mockResolvedValue(undefined);
    root.querySelector<HTMLButtonElement>('[data-print-version="filled"]')!.click();
    root.querySelector<HTMLButtonElement>("[data-print-test]")!.click();
    await until(() => print.mock.calls.length > 0);
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ rendition: "filled", page: { size: "letter" } }));
  });

  it("sends the renderer's datum-print on from the surface, so the page hears the test page", async () => {
    const element = await mount();
    const { surface } = await openPrint(element);
    const heard: Array<{ html: string }> = [];
    document.addEventListener(
      "datum-print",
      (event) => {
        heard.push((event as CustomEvent<{ html: string }>).detail);
        event.preventDefault();
      },
      { once: true }
    );
    await surface.previewRenderer!.print({ rendition: "answers" });
    expect(heard).toHaveLength(1);
    expect(heard[0]!.html).toContain("datum-print");
  });

  it("draws the estimated page starts and the header and footer strips over the sheet", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const lines = [...root.querySelectorAll<HTMLElement>("[data-print-break]")];
    expect(lines.map((line) => line.dataset.printBreak)).toEqual(["estimated"]);
    expect(lines[0]!.textContent).toBe("Page 2 starts about here");
    expect(root.querySelector("[data-print-pages]")!.textContent).toBe("About 2 pages · Letter");
    // The default header prints the title at its start; the footer the page number line at its end,
    // numbered as the last page, since its strip is at the foot of the whole sheet.
    expect(root.querySelector('[data-print-header] [data-slot="start"]')!.textContent).toBe("Sample");
    expect(root.querySelector('[data-print-footer] [data-slot="end"]')!.textContent).toBe("Page 2 of 2");
    expect(root.querySelector("[data-print-chromium]")!.textContent).toContain("Firefox and Safari");
    // An author's break is an accent line naming the component.
    surface.measurePreview = () => ({ height: 1400, blocks: [{ top: 0, height: 200, componentId: "fullName" }, { top: 200, height: 100, componentId: "country", breakBefore: true }] });
    await until(() => root.querySelector('[data-print-break="forced"]'));
    expect(root.querySelector('[data-print-break="forced"]')!.textContent).toBe("New page: Country");
  });

  it("selects a component clicked on the sheet and shows its On paper fields, written through the controller", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const frame = root.querySelector<HTMLIFrameElement>("iframe[data-print-frame]:not([data-print-frame-back])")!;
    const doc = frame.contentDocument!;
    const target = doc.querySelector<HTMLElement>('[data-component-id="email"]') ?? doc.querySelector<HTMLElement>('[data-component-id="fullName"]')!;
    const id = target.getAttribute("data-component-id")!;
    target.click();
    expect(element.controller!.selectedComponentId()).toBe(id);
    await until(() => root.querySelector("[data-print-on-paper] [data-prop='print.breakBefore']"));
    expect(root.querySelector(`[data-print-component="${id}"]`)).not.toBeNull();
    const breakBefore = root.querySelector<HTMLInputElement>("[data-print-on-paper] [data-prop='print.breakBefore']")!;
    breakBefore.checked = true;
    breakBefore.dispatchEvent(new Event("change", { bubbles: true }));
    const node = element.definition.root.children!.content!.find((child) => child.id === id)!;
    expect((node.configuration as { print?: { breakBefore?: boolean } }).print?.breakBefore).toBe(true);
    // Back on the card, the component is listed with its Clear.
    root.querySelector<HTMLButtonElement>("[data-print-back]")!.click();
    await until(() => root.querySelector(`[data-print-entry="${id}"]`));
    root.querySelector<HTMLButtonElement>(`[data-print-clear="${id}"]`)!.click();
    const cleared = element.definition.root.children!.content!.find((child) => child.id === id)!;
    expect((cleared.configuration as { print?: { breakBefore?: boolean } }).print?.breakBefore).toBeUndefined();
    await surface.previewSettled();
  });

  it("says when the print theme asked for is set aside and the basic look is shown", async () => {
    const element = await mount((el) => {
      el.printTheme = { id: "acme", label: "Acme", css: "", draw: { field: () => "raw markup" as never } };
    });
    const { root } = await openPrint(element);
    const notice = root.querySelector<HTMLElement>("[data-print-fallback]")!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("The Acme print theme cannot draw this form as it should, so the preview shows the basic look.");
  });

  it("shows an empty state for a form with nothing to print", async () => {
    const definition = sampleDefinition();
    definition.root.children = { content: [] };
    const element = await mount(undefined, definition);
    element.builder!.setWorkspace("print");
    await until(() => surfaceOf(element)?.shadowRoot?.querySelector("[data-print-settings] h2"));
    const root = surfaceOf(element)!.shadowRoot!;
    await until(() => root.querySelector<HTMLElement>("[data-print-empty]")?.hidden === false);
    expect(root.querySelector<HTMLElement>("[data-print-scroller]")!.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("[data-print-test]")!.disabled).toBe(true);
  });

  it("offers no Print workspace when the features list leaves print out, and fetches nothing", async () => {
    const element = await mount((el) => el.setAttribute("features", "all -print"));
    const builder = element.builder!;
    expect(builder.availableWorkspaces()).not.toContain("print");
    expect(shell(element).querySelector<HTMLElement>('[data-workspace-tab="print"]')!.hidden).toBe(true);
    expect(builder.setWorkspace("print")).toBe(false);
    await pause(30);
    expect(asked.print).toBe(0);
  });
});

describe("the Print workspace's sheet while it is not on the page", () => {
  it("draws nothing while another workspace is on, and draws once and measures again when Print is back", async () => {
    const element = await mount();
    const builder = element.builder!;
    const { surface } = await openPrint(element);
    const prepare = vi.spyOn(surface.previewRenderer!, "preparePrintDocument");
    let measured = 0;
    surface.measurePreview = () => {
      measured += 1;
      return MEASURE();
    };
    builder.setWorkspace("form");
    await until(() => builder.workspace === "form");
    expect(surface.shown).toBe(false);
    element.controller!.setProperty("fullName", "label", "Name one");
    element.controller!.setProperty("fullName", "label", "Name two");
    await pause(400);
    expect(prepare).not.toHaveBeenCalled();
    measured = 0;
    builder.setWorkspace("print");
    await until(() => builder.workspace === "print");
    expect(surface.shown).toBe(true);
    await pause(10);
    await surface.previewSettled();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(measured).toBeGreaterThanOrEqual(1);
    expect(surface.prepared!.html).toContain("Name two");
  });

  it("lets the runtime it drew from go when it draws from another, when it is hidden and when it leaves the page", async () => {
    const element = await mount();
    const builder = element.builder!;
    const { surface } = await openPrint(element);
    const made: Array<{ disposed: boolean }> = [];
    // A mode's session stood in: the surface waits for it, draws from it and disposes it.
    Object.assign(surface.sources, {
      journeySession: () => {
        const record = { disposed: false };
        made.push(record);
        const runtime = new BuilderPreviewRuntime(element.controller!.snapshot());
        return { runtime, ready: async () => undefined, dispose: () => (record.disposed = true) };
      }
    });
    element.controller!.setProperty("fullName", "label", "Again");
    await pause(300);
    await surface.previewSettled();
    expect(made.map((record) => record.disposed)).toEqual([false]);
    expect(surface.previewRenderer!.dataSources).toBe(element.controller!.dataSources());
    element.controller!.setProperty("fullName", "label", "Once more");
    await pause(300);
    await surface.previewSettled();
    expect(made.map((record) => record.disposed)).toEqual([true, false]);
    builder.setWorkspace("form");
    await until(() => builder.workspace === "form");
    expect(made.every((record) => record.disposed)).toBe(true);
    builder.setWorkspace("print");
    await until(() => builder.workspace === "print");
    await pause(10);
    await surface.previewSettled();
    expect(made).toHaveLength(3);
    expect(made[2]!.disposed).toBe(false);
    // Off the page: the session and the renderer go; back on it, both are made again.
    const host = surface.parentElement!;
    surface.remove();
    expect(made[2]!.disposed).toBe(true);
    expect(surface.previewRenderer).toBeUndefined();
    host.append(surface);
    await pause(10);
    await surface.previewSettled();
    expect(made).toHaveLength(4);
    expect(surface.previewRenderer).toBeDefined();
  });
});

describe("the Print workspace's typed values", () => {
  it("never writes a value typed for one document into another loaded into the same builder", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const input = root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    typeInto(input, "Typed for the first form");
    const next = sampleDefinition();
    next.id = "another-form";
    (next.root.configuration as Record<string, unknown>).title = "Another";
    element.definition = next;
    await until(() => (element.definition.root.configuration as { title?: string }).title === "Another");
    await pause(500);
    expect(printBlock(element)?.header).toBeUndefined();
    await until(() => root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')?.value === "");
  });

  it("takes the typing back on a Ctrl+Z pressed in the slot box: the waiting value written, then undone, one step", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const controller = element.controller!;
    expect(controller.canUndo()).toBe(false);
    const box = (): HTMLInputElement => root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    const badge = (): HTMLElement => root.querySelector<HTMLElement>('[data-print-slot-default="header.end"]')!;
    const input = box();
    const shellStep = vi.spyOn(element.builder!, "historyStep");
    typeInto(input, "Ref");
    expect(badge().hidden).toBe(true);
    // The key alone: the browser's own text undo does not run, the form's history steps, through the shell's one Undo.
    const undo = press(input, "z", { ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(shellStep).toHaveBeenCalledWith("undo", controller);
    expect(printBlock(element)?.header).toBeUndefined();
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);
    // The box typed in, still focused, shows the form's value, and its Default badge is back.
    expect(root.activeElement).toBe(box());
    expect(box().value).toBe("");
    expect(badge().hidden).toBe(false);
    await pause(500);
    expect(printBlock(element)?.header).toBeUndefined();
    expect(controller.canUndo()).toBe(false);
    // Shift+Z and Y redo; Cmd is Ctrl's twin.
    expect(press(box(), "Z", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBe("Ref");
    expect(box().value).toBe("Ref");
    expect(badge().hidden).toBe(true);
    press(box(), "z", { metaKey: true });
    expect(printBlock(element)?.header).toBeUndefined();
    expect(box().value).toBe("");
    press(box(), "y", { ctrlKey: true });
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBe("Ref");
    expect(box().value).toBe("Ref");
    // Typed on from a written value: the step takes back only the typing, and the box shows it.
    typeInto(box(), "Refs");
    press(box(), "z", { ctrlKey: true });
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBe("Ref");
    expect(box().value).toBe("Ref");
    // The scale box alike.
    const scale = (): HTMLInputElement => root.querySelector<HTMLInputElement>("input[data-print-scale]")!;
    const scaleBefore = scale().value;
    typeInto(scale(), "80");
    press(scale(), "z", { ctrlKey: true });
    expect(printBlock(element)?.scale).toBeUndefined();
    expect(scale().value).toBe(scaleBefore);
    // A key that steps nothing on this form leaves no stale mark behind: typing on keeps its text
    // across the next repaint (here a label change from elsewhere redraws the card).
    surfaceOf(element)!.historyStep = () => undefined;
    press(box(), "z", { ctrlKey: true });
    typeInto(box(), "Ref.");
    controller.setProperty("fullName", "label", "Whole name");
    expect(root.activeElement).toBe(box());
    expect(box().value).toBe("Ref.");
  });

  it("takes the typing back in a component's On paper box on Ctrl+Z, and the box shows the form's value", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const controller = element.controller!;
    const picker = root.querySelector<HTMLSelectElement>("select[data-print-pick]")!;
    picker.value = "fullName";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => root.querySelector('[data-print-component="fullName"]'));
    const note = (): HTMLInputElement => root.querySelector<HTMLInputElement>("[data-print-on-paper] input[data-prop='print.note']")!;
    const stored = (): unknown => (element.definition.root.children!.content!.find((child) => child.id === "fullName")?.configuration as { print?: { note?: unknown } } | undefined)?.print?.note;
    typeInto(note(), "Only if married");
    expect(press(note(), "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(stored()).toBeUndefined();
    expect(root.activeElement).toBe(note());
    expect(note().value).toBe("");
    press(note(), "z", { ctrlKey: true, shiftKey: true });
    expect(stored()).toBe("Only if married");
    expect(note().value).toBe("Only if married");
  });

  it("leaves the keys to the browser's text undo in the pasted submission and the sample receipt", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const controller = element.controller!;
    const title = root.querySelector<HTMLInputElement>("[data-print-title-first]")!;
    title.checked = false;
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect(controller.canUndo()).toBe(true);
    const steps: string[] = [];
    surface.historyStep = (_stepped, direction) => steps.push(direction);
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = "pasted";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    for (const selector of ["[data-print-pasted]", "[data-print-receipt]"]) {
      const box = root.querySelector<HTMLTextAreaElement>(selector)!;
      typeInto(box, '{ "a": 1 }');
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }] as KeyboardEventInit[]) {
        expect(press(box, init.shiftKey ? "Z" : "z", init).defaultPrevented).toBe(false);
      }
      expect(press(box, "y", { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(box.value).toBe('{ "a": 1 }');
    }
    expect(steps).toEqual([]);
    expect(printBlock(element)?.titleOnFirstPage).toBe(false);
    // Out of them, the keys are the form's again.
    expect(press(root.querySelector<HTMLInputElement>("[data-print-title-first]")!, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(steps).toEqual(["undo"]);
  });

  it("undoes the form from a box that is not typed in, and steps through the shell's historyStep when it is set", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const controller = element.controller!;
    const title = root.querySelector<HTMLInputElement>("[data-print-title-first]")!;
    title.focus();
    title.checked = false;
    title.dispatchEvent(new Event("change", { bubbles: true }));
    expect(printBlock(element)?.titleOnFirstPage).toBe(false);
    press(root.querySelector<HTMLInputElement>("[data-print-title-first]")!, "z", { ctrlKey: true });
    expect(printBlock(element)?.titleOnFirstPage).toBeUndefined();
    // The shell's seam: the key goes there, the controller is not stepped behind its back.
    const steps: Array<[unknown, string]> = [];
    surface.historyStep = (stepped, direction) => steps.push([stepped, direction]);
    press(root.querySelector<HTMLSelectElement>("[data-print-default]")!, "y", { ctrlKey: true });
    press(root.querySelector<HTMLSelectElement>("[data-print-default]")!, "z", { ctrlKey: true });
    expect(steps).toEqual([
      [controller, "redo"],
      [controller, "undo"]
    ]);
    expect(printBlock(element)?.titleOnFirstPage).toBeUndefined();
    expect(controller.canRedo()).toBe(true);
  });
});

describe("the Print workspace by keyboard", () => {
  it("offers every component that prints in a labelled picker that opens its On paper fields, and a toolbar that is one Tab stop", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const toolbar = root.querySelector<HTMLElement>("[data-print-toolbar]")!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    // Named apart from the Preview card beside the settings.
    expect(toolbar.getAttribute("aria-label")).toBe("Preview tools");
    // One Tab stop (the ARIA toolbar): the first tool, the arrows move it.
    const stops = (): HTMLElement[] => [...toolbar.querySelectorAll<HTMLElement>("button")].filter((button) => button.getAttribute("tabindex") === "0");
    expect(stops().length).toBe(1);
    const first = stops()[0]!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, composed: true }));
    expect(stops().length).toBe(1);
    expect(stops()[0]).not.toBe(first);
    expect(root.activeElement).toBe(stops()[0]);
    stops()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, composed: true }));
    expect(root.activeElement).toBe(first);
    expect(root.getElementById(root.querySelector("[data-print-preview]")!.getAttribute("aria-labelledby")!)!.textContent).toBe("Preview");
    const picker = (): HTMLSelectElement => root.querySelector<HTMLSelectElement>("select[data-print-pick]")!;
    expect(picker().closest("label")!.textContent).toContain("Component");
    const values = [...picker().options].map((option) => option.value);
    expect(values.slice(0, 4)).toEqual(["", "fullName", "country", "subscribe"]);
    expect(picker().options[1]!.textContent).toBe("Full name (text)");
    picker().focus();
    picker().value = "country";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    expect(element.controller!.selectedComponentId()).toBe("country");
    await until(() => root.querySelector('[data-print-component="country"]'));
    expect(root.querySelector("[data-print-on-paper] [data-prop='print.breakBefore']")).not.toBeNull();
    expect(root.activeElement).toBe(picker());
    expect(picker().value).toBe("country");
    picker().value = "";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => root.querySelector("[data-print-versions]"));
    expect(root.querySelector("[data-print-component]")).toBeNull();
  });

  it("offers a slot's inserts as a menu button: the arrows walk the items and write nothing, Escape gives focus back", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const controller = element.controller!;
    const button = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('button[data-print-insert="header.end"]')!;
    const menu = (): HTMLElement => root.querySelector<HTMLElement>('[data-print-insert-menu="header.end"]')!;
    const items = (): HTMLElement[] => [...menu().querySelectorAll<HTMLElement>("[role=menuitem]")];
    expect(root.querySelector("select[data-print-insert]")).toBeNull();
    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().getAttribute("aria-controls")).toBe(menu().id);
    expect(button().getAttribute("aria-label")).toBe("Insert into Header, end");
    expect(menu().getAttribute("role")).toBe("menu");
    expect(menu().hidden).toBe(true);
    expect(items().every((item) => item.localName === "button" && item.getAttribute("tabindex") === "-1")).toBe(true);
    expect(items().map((item) => item.textContent)).toEqual(expect.arrayContaining(["Form title", "Page numbers", "Date printed", "Receipt value…", "Full name"]));
    // ArrowDown on the button opens the menu on its first item; the arrows, Home and End walk it.
    button().focus();
    expect(press(button(), "ArrowDown").defaultPrevented).toBe(true);
    expect(menu().hidden).toBe(false);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(root.activeElement).toBe(items()[0]);
    press(items()[0]!, "ArrowDown");
    expect(root.activeElement).toBe(items()[1]);
    press(items()[1]!, "End");
    expect(root.activeElement).toBe(items().at(-1));
    press(items().at(-1)!, "ArrowDown");
    expect(root.activeElement).toBe(items()[0]);
    press(items()[0]!, "ArrowUp");
    expect(root.activeElement).toBe(items().at(-1));
    press(items().at(-1)!, "Home");
    expect(root.activeElement).toBe(items()[0]);
    // Nothing was written by walking the menu.
    expect(controller.canUndo()).toBe(false);
    expect(printBlock(element)).toBeUndefined();
    // Escape puts it away, focus back on its button.
    press(items()[0]!, "Escape");
    expect(menu().hidden).toBe(true);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(button());
    // ArrowUp opens it on its last item; a click outside puts it away.
    press(button(), "ArrowUp");
    expect(root.activeElement).toBe(items().at(-1));
    root.querySelector<HTMLElement>("[data-print-versions] h3")!.click();
    expect(menu().hidden).toBe(true);
    // An item writes its placeholder, one step, and focus goes to the slot box after it.
    button().click();
    expect(menu().hidden).toBe(false);
    expect(root.activeElement).toBe(items()[0]);
    root.querySelector<HTMLButtonElement>('[data-print-insert-item="header.end|date"]')!.click();
    expect(menu().hidden).toBe(true);
    expect((printBlock(element)?.header as { end?: string }).end).toBe("{{date}}");
    const box = root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    expect(root.activeElement).toBe(box);
    expect(box.selectionStart).toBe("{{date}}".length);
    controller.undo();
    expect(controller.canUndo()).toBe(false);
  });

  it("keeps focus on the Insert menu's item when the card is drawn again while the menu is open", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const button = root.querySelector<HTMLButtonElement>('button[data-print-insert="header.end"]')!;
    button.focus();
    press(button, "ArrowDown");
    press(root.activeElement!, "ArrowDown");
    const item = (root.activeElement as HTMLElement).getAttribute("data-print-insert-item");
    expect(item).toMatch(/^header\.end\|/);
    // An edit from elsewhere that changes the card's markup (a field's label in the Fields group).
    element.controller!.setProperty("fullName", "label", "Whole name");
    await until(() => [...root.querySelectorAll('[data-print-insert-menu="header.end"] [role=menuitem]')].some((entry) => entry.textContent === "Whole name"));
    expect(root.querySelector<HTMLElement>('[data-print-insert-menu="header.end"]')!.hidden).toBe(false);
    expect((root.activeElement as HTMLElement | null)?.getAttribute("data-print-insert-item")).toBe(item);
    // The keys still reach the menu.
    press(root.activeElement!, "Escape");
    expect(root.activeElement).toBe(root.querySelector('button[data-print-insert="header.end"]'));
  });

  it("drops a slot's Default badge as soon as anything is typed, its default's words too, and stores them as the author's", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const box = root.querySelector<HTMLInputElement>('[data-print-slot="footer.end"]')!;
    const badge = root.querySelector<HTMLElement>('[data-print-slot-default="footer.end"]')!;
    const reset = root.querySelector<HTMLElement>('[data-print-slot-reset="footer.end"]')!;
    expect(box.value).toBe("Page {{page}} of {{pages}}");
    expect(badge.hidden).toBe(false);
    typeInto(box, "Page {{page}} of {{pages}}");
    // Before the write lands.
    expect(printBlock(element)).toBeUndefined();
    expect(root.querySelector<HTMLElement>('[data-print-slot-default="footer.end"]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-print-slot-reset="footer.end"]')!.hidden).toBe(false);
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect((printBlock(element)?.footer as { end?: string }).end).toBe("Page {{page}} of {{pages}}");
    expect(root.querySelector<HTMLElement>('[data-print-slot-default="footer.end"]')!.hidden).toBe(true);
    expect(reset.isConnected ? reset.hidden : root.querySelector<HTMLElement>('[data-print-slot-reset="footer.end"]')!.hidden).toBe(false);
  });

  it("leaves no print block and no history step when a setting never written is put back to its default", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const controller = element.controller!;
    expect(JSON.stringify(controller.snapshot().configuration)).not.toContain('"print"');
    root.querySelector<HTMLButtonElement>('[data-print-slot-reset="header.start"]')!.click();
    expect(JSON.stringify(controller.snapshot().configuration)).not.toContain('"print"');
    expect(controller.canUndo()).toBe(false);
    // Unticked and ticked again: the block the first write made goes with the second.
    const title = (): HTMLInputElement => root.querySelector<HTMLInputElement>("[data-print-title-first]")!;
    title().checked = false;
    title().dispatchEvent(new Event("change", { bubbles: true }));
    expect(printBlock(element)?.titleOnFirstPage).toBe(false);
    title().checked = true;
    title().dispatchEvent(new Event("change", { bubbles: true }));
    expect(JSON.stringify(controller.snapshot().configuration)).not.toContain('"print"');
  });

  it("names the components in the card in the form's language as it is switched, and as their translations change", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const controller = element.controller!;
    const option = (id: string): string | undefined =>
      [...root.querySelectorAll<HTMLOptionElement>("select[data-print-pick] option")].find((entry) => entry.value === id)?.textContent?.trim();
    expect(option("fullName")).toBe("Full name (text)");
    controller.setOptions({ locale: "fr-CA" });
    await until(() => option("fullName") === "Nom complet (text)");
    controller.setTranslations([{ locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "Nom et prénom" }]);
    await until(() => option("fullName") === "Nom et prénom (text)");
    controller.undo();
    await until(() => option("fullName") === "Nom complet (text)");
  });

  it("keeps an open help note open when a box below it draws the card again", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const picker = root.querySelector<HTMLSelectElement>("select[data-print-pick]")!;
    picker.value = "fullName";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => root.querySelector("[data-print-on-paper] [data-help-toggle]"));
    const toggle = root.querySelector<HTMLButtonElement>("[data-print-on-paper] [data-help-toggle]")!;
    const path = toggle.getAttribute("data-help-toggle")!;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const breakBefore = root.querySelector<HTMLInputElement>("[data-print-on-paper] [data-prop='print.breakBefore']")!;
    breakBefore.checked = true;
    breakBefore.dispatchEvent(new Event("change", { bubbles: true }));
    const again = root.querySelector<HTMLButtonElement>(`[data-print-on-paper] [data-help-toggle="${path}"]`)!;
    expect(again.getAttribute("aria-expanded")).toBe("true");
    expect(root.getElementById(again.getAttribute("aria-controls")!)!.hidden).toBe(false);
  });
});

describe("the Print workspace's words", () => {
  it("shows and inserts the engine's page number line in the form's default language, as the form words it", async () => {
    const definition = sampleDefinition();
    definition.localization = { defaultLocale: "fr", supportedLocales: [{ code: "fr", label: "Français" }, { code: "en", label: "English" }] };
    definition.translations = { fr: { texts: { form: { printPageNumber: { text: "Page {{page}} sur {{pages}}", source: "x" } } } } } as unknown as NonNullable<FormDefinition["translations"]>;
    const element = await mount(undefined, definition);
    const { root } = await openPrint(element);
    expect(root.querySelector<HTMLInputElement>('[data-print-slot="footer.end"]')!.value).toBe("Page {{page}} sur {{pages}}");
    insertFromMenu(root, "header.end", "pages");
    expect((printBlock(element)?.header as { end?: string }).end).toBe("Page {{page}} sur {{pages}}");
  });

  it("names the sheet's frames and the receipt box's example in the builder's language", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    expect(root.querySelector<HTMLTextAreaElement>("[data-print-receipt]")!.getAttribute("placeholder")).toBe('{ "reference": "CG-2026-00418" }');
    element.builder!.textCatalog = { fr: { "printing.frame": "Le formulaire imprimé", "printing.receipt.placeholder": "{ \"référence\": \"A-1\" }" } as never };
    element.builder!.textLocale = "fr";
    await until(() => root.querySelector("iframe[data-print-frame]")?.getAttribute("title") === "Le formulaire imprimé");
    expect([...root.querySelectorAll("iframe[data-print-frame]")].map((frame) => frame.getAttribute("title"))).toEqual(["Le formulaire imprimé", "Le formulaire imprimé"]);
    expect(root.querySelector<HTMLTextAreaElement>("[data-print-receipt]")!.getAttribute("placeholder")).toBe('{ "référence": "A-1" }');
  });

  it("prints Try it's host values where a slot reads host", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    typeInto(root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!, "Office {{host.office}}");
    element.controller!.setTryHostContext({ office: "Ottawa" });
    await pause(700);
    await surface.previewSettled();
    expect(surface.prepared!.model.page.header.end).toEqual([{ text: "Office Ottawa" }]);
  });
});

describe("a journey form in the Print workspace", () => {
  function journeyForm(): FormDefinition {
    const definition = sampleDefinition();
    return {
      ...definition,
      journey: {
        journeys: [
          {
            id: "intake",
            name: "Intake",
            pages: [
              { id: "about", title: "About you", components: ["fullName"] },
              { id: "where", title: "Where", components: ["country"] },
              { id: "mail", title: "Mail", components: ["subscribe", "email"] }
            ]
          }
        ],
        defaultJourneyId: "intake"
      },
      tests: { scenarios: [{ id: "grace", source: 'test "Grace"\n  set fullName = "Grace Hopper"' }] } as unknown as FormDefinition["tests"]
    } as FormDefinition;
  }

  async function journeyPrint(element: DatumFormBuilderElement): Promise<{ surface: DatumBuilderPrintElement; root: ShadowRoot }> {
    await modesReady(element);
    const opened = await openPrint(element);
    await until(() => opened.surface.prepared?.model.nodes.some((node) => node.kind === "section" && node.from === "page") === true, 6000);
    return opened;
  }

  const choose = async (surface: DatumBuilderPrintElement, root: ShadowRoot, value: string): Promise<void> => {
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = value;
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    await pause(10);
    await surface.previewSettled();
  };

  it("prints the journey's pages from no answers, a test scenario and pasted answers", async () => {
    const element = await mount(undefined, journeyForm());
    const { surface, root } = await journeyPrint(element);
    // No answers: the journey's pages, nothing answered.
    expect(surface.prepared!.html).not.toContain("Ada Lovelace");
    expect(surface.prepared!.model.nodes.every((node) => node.kind === "section" && node.from === "page")).toBe(true);
    // A scenario, replayed to its end.
    await until(() => [...root.querySelectorAll<HTMLOptionElement>("[data-print-sample] option")].some((option) => option.value.startsWith("scenario:")));
    const scenario = [...root.querySelectorAll<HTMLOptionElement>("[data-print-sample] option")].find((option) => option.value.startsWith("scenario:"))!.value;
    await choose(surface, root, scenario);
    await until(() => surface.prepared!.html.includes("Grace Hopper"), 4000);
    expect(surface.prepared!.model.nodes.every((node) => node.kind === "section" && node.from === "page")).toBe(true);
    // Pasted.
    await choose(surface, root, "pasted");
    typeInto(root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")!, JSON.stringify({ fullName: "Ada Lovelace" }));
    await pause(300);
    await surface.previewSettled();
    await until(() => surface.prepared!.html.includes("Ada Lovelace"), 4000);
    expect(surface.prepared!.html).not.toContain("Grace Hopper");
    // None again.
    await choose(surface, root, "none");
    await until(() => !surface.prepared!.html.includes("Ada Lovelace"), 4000);
  });

  it("leaves a Try it running in Journeys as it is: Print's session is its own, and a hidden Print draws nothing", async () => {
    const element = await mount(undefined, journeyForm());
    const { surface } = await journeyPrint(element);
    const builder = element.builder!;
    element.journeyMode!.view = "step";
    element.mode = "journeys";
    await until(() => builder.mode === "journeys" && element.journeyMode?.ready);
    const canvas = builder.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => canvas.querySelector<HTMLElement>("[data-try-it]"));
    canvas.querySelector<HTMLElement>("[data-try-it]")!.click();
    await until(() => element.journeyMode?.previewRuntime !== undefined, 6000);
    // An edit while Print is hidden: nothing of Print's runs, and Try it goes on.
    const prepare = vi.spyOn(surface.previewRenderer!, "preparePrintDocument");
    element.controller!.setProperty("fullName", "label", "Your name");
    await pause(400);
    expect(prepare).not.toHaveBeenCalled();
    await until(() => element.journeyMode?.previewRuntime !== undefined);
    const tried = element.journeyMode!.previewRuntime!;
    // A print session made while Try it runs: Try it's journey stays, and goes on after the print's is let go.
    const session = surface.sources.journeySession!({ fullName: "Ada Lovelace" })!;
    await session.ready();
    expect(session.runtime).toBeDefined();
    expect(session.runtime).not.toBe(tried);
    expect(element.journeyMode!.previewRuntime).toBe(tried);
    session.dispose();
    expect(element.journeyMode!.previewRuntime).toBe(tried);
    expect(canvas.querySelector("[data-try-panel] .try-card[data-try-journey]")).not.toBeNull();
  });
});
