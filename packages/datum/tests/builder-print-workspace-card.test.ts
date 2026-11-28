import { afterEach, describe, expect, it } from "vitest";

/*
 * The Print workspace's card and bar as the keyboard and a screen reader meet them: what a paint
 * keeps (focus after Back and Clear, option values that changed), what the boxes say (the scale's
 * problem, the samples' labels and errors), the zoom's ends, an emptied form, a scenario edited
 * while Print was hidden, and the typed values the shell writes at once before a save.
 */
import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumBuilderPrintElement } from "../../../engine/form-engine/builder/print/print-surface.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(definition: FormDefinition = sampleDefinition(), setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("features", "-pdf");
  element.definition = definition;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const surfaceOf = (element: DatumFormBuilderElement): DatumBuilderPrintElement | null =>
  element.builder!.shadowRoot!.querySelector("datum-builder-print") as DatumBuilderPrintElement | null;

const MEASURE = (): { height: number; blocks: Array<{ top: number; height: number; componentId?: string }> } => ({
  height: 1600,
  blocks: [
    { top: 0, height: 900, componentId: "fullName" },
    { top: 900, height: 120, componentId: "country" }
  ]
});

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

/** The sample form with a page break set on `ids`, so the card lists them with Show and Clear. */
function withBreaks(...ids: string[]): FormDefinition {
  const definition = sampleDefinition();
  for (const child of definition.root.children!.content!) {
    if (ids.includes(child.id)) {
      child.configuration = { ...(child.configuration ?? {}), print: { breakBefore: true } };
    }
  }
  return definition;
}

describe("the Print card's paints", () => {
  it("takes an option whose value changed (an id renamed, its label kept) into the picker and the Insert menus", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const pickValues = (): string[] => [...root.querySelectorAll<HTMLOptionElement>("select[data-print-pick] option")].map((option) => option.value);
    const insertValues = (): string[] =>
      [...root.querySelectorAll<HTMLElement>('[data-print-insert-menu="header.end"] [data-print-insert-item]')].map((item) => item.dataset.printInsertItem!.slice("header.end|".length));
    expect(pickValues()).toContain("subscribe");
    expect(insertValues()).toContain("field:subscribe");
    element.controller!.renameId("subscribe", "optIn");
    expect(pickValues()).toContain("optIn");
    expect(pickValues()).not.toContain("subscribe");
    expect(insertValues()).toContain("field:optIn");
    expect(insertValues()).not.toContain("field:subscribe");
  });

  it("puts focus back on the component's Show after Back, and on the next entry's Clear after a Clear", async () => {
    const element = await mount(withBreaks("fullName", "country"));
    const { root } = await openPrint(element);
    const show = root.querySelector<HTMLButtonElement>('button[data-print-show="country"]')!;
    show.focus();
    show.click();
    await until(() => root.querySelector('[data-print-component="country"]'));
    expect(root.activeElement).toBe(root.querySelector("[data-print-back]"));
    root.querySelector<HTMLButtonElement>("[data-print-back]")!.click();
    expect(root.querySelector("[data-print-component]")).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('button[data-print-show="country"]'));
    // Clear the first entry: the next one's Clear takes focus.
    const first = root.querySelector<HTMLButtonElement>('button[data-print-clear="fullName"]')!;
    first.focus();
    first.click();
    expect(root.querySelector('[data-print-entry="fullName"]')).toBeNull();
    expect(root.activeElement).toBe(root.querySelector('button[data-print-clear="country"]'));
    // Clear the last: the list's "none" line takes it.
    root.querySelector<HTMLButtonElement>('button[data-print-clear="country"]')!.click();
    const none = root.querySelector<HTMLElement>("[data-print-breaks-none]")!;
    expect(none).not.toBeNull();
    expect(none.getAttribute("tabindex")).toBe("-1");
    expect(root.activeElement).toBe(none);
  });

  it("marks a scale out of range invalid, and drops the problem when the box takes the form's value again", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    const scale = root.querySelector<HTMLInputElement>("input[data-print-scale]")!;
    const problem = root.querySelector<HTMLElement>("[data-print-scale-problem]")!;
    typeInto(scale, "300");
    expect(scale.getAttribute("aria-invalid")).toBe("true");
    expect(problem.hidden).toBe(false);
    scale.dispatchEvent(new Event("change", { bubbles: true }));
    // An edit elsewhere in the card: the scale box, not being typed in, shows the form's 100 again.
    const slot = root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!;
    typeInto(slot, "Ref");
    slot.dispatchEvent(new Event("change", { bubbles: true }));
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBe("Ref");
    const after = root.querySelector<HTMLInputElement>("input[data-print-scale]")!;
    expect(after.value).toBe("100");
    expect(after.hasAttribute("aria-invalid")).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-print-scale-problem]")!.hidden).toBe(true);
  });
});

describe("the Print preview's boxes and bar", () => {
  it("labels each sample box by its caption alone, and writes its error only when the words change", async () => {
    const element = await mount();
    const { root } = await openPrint(element);
    for (const [box, hint] of [
      ["[data-print-pasted]", "#print-pasted-hint"],
      ["[data-print-receipt]", "#print-receipt-hint"]
    ] as const) {
      const textarea = root.querySelector<HTMLTextAreaElement>(box)!;
      expect(textarea.labels).toHaveLength(1);
      const label = textarea.labels[0]!;
      expect(label.htmlFor).toBe(textarea.id);
      expect(label.contains(root.querySelector(hint))).toBe(false);
      expect(label.contains(textarea)).toBe(false);
    }
    expect(root.querySelector("#print-receipt-field")!.hasAttribute("data-print-receipt-field")).toBe(true);
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = "pasted";
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    const pasted = root.querySelector<HTMLTextAreaElement>("[data-print-pasted]")!;
    const error = root.querySelector<HTMLElement>("[data-print-pasted-error]")!;
    // An alert, said as it shows (a polite region that just entered the tree is not read).
    expect(error.getAttribute("role")).toBe("alert");
    expect(root.querySelector("[data-print-receipt-error]")!.getAttribute("role")).toBe("alert");
    typeInto(pasted, "{ not");
    expect(error.textContent).toBe("That is not JSON.");
    expect(pasted.getAttribute("aria-invalid")).toBe("true");
    const said = error.firstChild;
    typeInto(pasted, "{ not json");
    expect(error.firstChild).toBe(said);
    typeInto(pasted, JSON.stringify({ fullName: "Ada" }));
    expect(pasted.hasAttribute("aria-invalid")).toBe(false);
    expect(error.hidden).toBe(true);
  });

  it("shows the zoom as plain text written only when it changes, and keeps a Fit below the smallest step on Zoom out", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    const value = (): HTMLElement => root.querySelector<HTMLElement>("[data-print-zoom-value]")!;
    expect(value().localName).toBe("span");
    expect(root.querySelector("output")).toBeNull();
    const shown = value().firstChild;
    element.controller!.setProperty("fullName", "label", "Your name");
    await pause(300);
    await surface.previewSettled();
    expect(value().firstChild).toBe(shown);
    // A narrow pane: Fit is about a third.
    const scroller = root.querySelector<HTMLElement>("[data-print-scroller]")!;
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 300 });
    root.querySelector<HTMLButtonElement>('[data-print-zoom="fit"]')!.click();
    const fit = value().textContent;
    expect(fit).not.toBe("50%");
    expect(root.querySelector('[data-print-zoom="out"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(root.querySelector('[data-print-zoom="in"]')!.getAttribute("aria-disabled")).toBe("false");
    root.querySelector<HTMLButtonElement>('[data-print-zoom="out"]')!.click();
    expect(value().textContent).toBe(fit);
    expect(root.querySelector('[data-print-zoom="fit"]')!.getAttribute("aria-pressed")).toBe("true");
    // Zoom in steps up to 50%.
    root.querySelector<HTMLButtonElement>('[data-print-zoom="in"]')!.click();
    expect(value().textContent).toBe("50%");
    expect(root.querySelector('[data-print-zoom="out"]')!.getAttribute("aria-disabled")).toBe("true");
  });

  it("counts no pages and keeps no notice or document once the form is emptied", async () => {
    const element = await mount(sampleDefinition(), (el) => {
      el.printTheme = { id: "acme", label: "Acme", css: "", draw: { field: () => "raw markup" as never } };
    });
    const { root, surface } = await openPrint(element);
    expect(root.querySelector("[data-print-pages]")!.textContent).not.toBe("");
    expect(root.querySelector<HTMLElement>("[data-print-fallback]")!.hidden).toBe(false);
    const ids = element.definition.root.children!.content!.map((child) => child.id);
    element.controller!.removeComponents(ids);
    await pause(300);
    await surface.previewSettled();
    expect(root.querySelector<HTMLElement>("[data-print-empty]")!.hidden).toBe(false);
    expect(root.querySelector("[data-print-pages]")!.textContent).toBe("");
    expect(root.querySelector<HTMLElement>("[data-print-fallback]")!.hidden).toBe(true);
    expect(surface.prepared).toBeUndefined();
  });
});

describe("the Print workspace's samples and typed values", () => {
  it("replays a test scenario afresh when it was edited while Print was hidden", async () => {
    const definition = {
      ...sampleDefinition(),
      tests: { scenarios: [{ id: "grace", source: 'test "Grace"\n  set fullName = "Grace Hopper"' }] }
    } as unknown as FormDefinition;
    const element = await mount(definition);
    const builder = element.builder!;
    const { root, surface } = await openPrint(element);
    await until(() => [...root.querySelectorAll<HTMLOptionElement>("[data-print-sample] option")].some((option) => option.value.startsWith("scenario:")));
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = [...sample.options].find((option) => option.value.startsWith("scenario:"))!.value;
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    await pause(10);
    await surface.previewSettled();
    await until(() => surface.prepared!.html.includes("Grace Hopper"), 4000);
    builder.setWorkspace("form");
    await until(() => builder.workspace === "form");
    element.controller!.setTests({ scenarios: [{ id: "grace", source: 'test "Grace"\n  set fullName = "Ada Byron"' }] } as never);
    builder.setWorkspace("print");
    await until(() => builder.workspace === "print");
    await pause(10);
    await surface.previewSettled();
    await until(() => surface.prepared!.html.includes("Ada Byron"), 4000);
    expect(surface.prepared!.html).not.toContain("Grace Hopper");
  });

  it("never keeps a replay that was running when the tests were edited: the settled sheet has the new answers", async () => {
    const definition = {
      ...sampleDefinition(),
      tests: { scenarios: [{ id: "grace", source: 'test "Grace"\n  set fullName = "Grace Hopper"' }] }
    } as unknown as FormDefinition;
    const element = await mount(definition);
    const { root, surface } = await openPrint(element);
    await until(() => [...root.querySelectorAll<HTMLOptionElement>("[data-print-sample] option")].some((option) => option.value.startsWith("scenario:")));
    // The replay waits on a gate the test opens.
    const runner = (surface as unknown as { scenarios: { runner: { replay(...args: unknown[]): Promise<unknown> } } }).scenarios.runner;
    const replay = runner.replay.bind(runner);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = 0;
    runner.replay = async (...args: unknown[]) => {
      const result = replay(...args);
      if (held++ === 0) {
        await gate;
      }
      return result;
    };
    const sample = root.querySelector<HTMLSelectElement>("[data-print-sample]")!;
    sample.value = [...sample.options].find((option) => option.value.startsWith("scenario:"))!.value;
    sample.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => held === 1);
    element.controller!.setTests({ scenarios: [{ id: "grace", source: 'test "Grace"\n  set fullName = "Ada Byron"' }] } as never);
    // The tests block changed, so the scenarios are parsed afresh; once they are, and before the
    // draw the edit scheduled, the held replay of the old ones is let out.
    const scenarios = (): { runner: unknown } | undefined => (surface as unknown as { scenarios?: { runner: unknown } }).scenarios;
    await until(() => scenarios() !== undefined && scenarios()!.runner !== runner);
    open();
    await pause(300);
    await surface.previewSettled();
    await until(() => surface.prepared!.html.includes("Ada Byron"), 4000);
    // A later draw, with no edit between, takes the kept replay: it is the new one.
    root.querySelector<HTMLButtonElement>('[data-print-version="blank"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-print-version="answers"]')!.click();
    await pause(10);
    await surface.previewSettled();
    expect(surface.prepared!.html).toContain("Ada Byron");
    expect(surface.prepared!.html).not.toContain("Grace Hopper");
  });

  it("writes a waiting typed value at once on flushWrites(), and does nothing when none waits", async () => {
    const element = await mount();
    const { root, surface } = await openPrint(element);
    surface.flushWrites();
    const before = JSON.stringify(element.definition);
    expect(element.controller!.canUndo()).toBe(false);
    typeInto(root.querySelector<HTMLInputElement>('[data-print-slot="header.end"]')!, "Typed just now");
    expect(printBlock(element)?.header).toBeUndefined();
    surface.flushWrites();
    expect((printBlock(element)?.header as { end?: string } | undefined)?.end).toBe("Typed just now");
    surface.flushWrites();
    element.controller!.undo();
    expect(JSON.stringify(element.definition)).toBe(before);
    await pause(500);
    expect(JSON.stringify(element.definition)).toBe(before);
  });
});
