import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { BUILDER_DRAG_MIME_TYPE, type FormDefinition, type JourneyConfiguration } from "@argusvane/datum-engine";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/*
 * The Form fields strip panel of the Journeys workspace: offered in the
 * Step view only, listing the form's fields not on a step first and then those on one with the
 * step's name beside each; a click or a drag puts a field on the step shown, in one undo.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** `intake` asks the name on its first step and the subscription on its second; the country and the email are on no step. */
function journeyBlock(): JourneyConfiguration {
  return JSON.parse(
    JSON.stringify({
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "contact", title: "Keeping in touch", components: ["subscribe"] }
          ]
        }
      ],
      defaultJourneyId: "intake",
      opensAs: "form"
    })
  ) as JourneyConfiguration;
}

function withJourneys(): FormDefinition {
  return { ...sampleDefinition(), journey: journeyBlock() };
}

async function onStep(definition: FormDefinition = withJourneys()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("features", "-pdf");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
  element.mode = "journeys";
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const stripItem = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="fields"]')!;
const panel = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>("datum-builder-form-fields")!;
const body = (element: DatumFormBuilderElement): ShadowRoot => panel(element).shadowRoot!;

function viewButton(element: DatumFormBuilderElement, view: "map" | "step"): HTMLElement {
  return shell(element).querySelector<HTMLElement>(`[data-mode-actions] [data-journey-views] [data-journey-view="${view}"]`)!;
}

/** The rows by group: label (marker and tag stripped) and the tag's words. */
function groups(element: DatumFormBuilderElement): Record<string, Array<{ id: string; label: string; tag: string; disabled: boolean }>> {
  const out: Record<string, Array<{ id: string; label: string; tag: string; disabled: boolean }>> = {};
  for (const group of body(element).querySelectorAll<HTMLElement>("[data-fields-group]")) {
    out[group.dataset.fieldsGroup!] = [...group.querySelectorAll<HTMLElement>("[data-field-add]")].map((row) => ({
      id: row.dataset.fieldAdd!,
      label: row.querySelector(".field-label")!.firstChild!.textContent!.trim(),
      tag: row.querySelector(".field-tag")?.textContent ?? "",
      disabled: row.getAttribute("aria-disabled") === "true"
    }));
  }
  return out;
}

async function openPanel(element: DatumFormBuilderElement): Promise<void> {
  viewButton(element, "step").click();
  await until(() => element.journeyMode?.view === "step" && !stripItem(element).hidden);
  stripItem(element).click();
  await until(() => !panel(element).hidden && body(element).querySelector("[data-fields-list]"));
}

describe("the Form fields strip panel", () => {
  it("is offered in the Step view only: its strip item is there with the Step view up, away on the map, and an open panel gives way to the palette", async () => {
    const element = await onStep();
    expect(element.journeyMode!.view).toBe("map");
    expect(stripItem(element).hidden).toBe(true);
    expect(stripItem(element).getAttribute("aria-label")).toBe("Form fields");
    await openPanel(element);
    expect(stripItem(element).getAttribute("aria-selected")).toBe("true");
    expect(element.builder!.panel).toBe("fields");
    viewButton(element, "map").click();
    await until(() => element.journeyMode?.view === "map");
    expect(stripItem(element).hidden).toBe(true);
    expect(panel(element).hidden).toBe(true);
    expect(element.builder!.panel).toBe("components");
  }, 30_000);

  it("lists the form's fields in form order, not on a step first, then on a step with the step's name beside each, and counts each group", async () => {
    const element = await onStep();
    await openPanel(element);
    const listed = groups(element);
    expect(listed.none!.map((row) => row.id)).toEqual(["country", "email"]);
    expect(listed.on!.map((row) => [row.id, row.tag, row.disabled])).toEqual([
      ["fullName", "On this step", true],
      ["subscribe", "Keeping in touch", false]
    ]);
    // The field marked Required carries its marker; a heading says what the group is, with its count.
    expect(body(element).querySelector('[data-field-add="fullName"] .field-label')!.textContent).toContain("*");
    const headings = [...body(element).querySelectorAll(".fields-group")].map((heading) => [...heading.querySelectorAll("span")].map((part) => part.textContent));
    expect(headings).toEqual([
      ["Not on a step", "2"],
      ["On a step", "2"]
    ]);
    expect(body(element).querySelector(".card-title")!.textContent).toBe("Form fields");
  }, 30_000);

  it("narrows the list as the box is typed in, and keeps the box (and its focus) as it repaints", async () => {
    const element = await onStep();
    await openPanel(element);
    const input = body(element).querySelector<HTMLInputElement>("[data-fields-filter]")!;
    input.focus();
    input.value = "mail";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(groups(element).none!.map((row) => row.id)).toEqual(["email"]);
    expect(groups(element).on).toBeUndefined();
    expect(body(element).querySelector("[data-fields-filter]")).toBe(input);
    expect(body(element).activeElement).toBe(input);
    input.value = "zzz";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(body(element).querySelector("[data-fields-none]")!.textContent).toBe("No field matches.");
  }, 30_000);

  it("places a field on the step shown with a click, in one undo, then shows it as on this step and offers it no more", async () => {
    const element = await onStep();
    await openPanel(element);
    const mode = element.journeyMode!;
    const press = body(element).querySelector<HTMLElement>('[data-field-add="country"]')!;
    press.focus();
    press.click();
    await until(() => groups(element).on?.some((row) => row.id === "country"));
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName", "country"]);
    expect(groups(element).none!.map((row) => row.id)).toEqual(["email"]);
    const row = groups(element).on!.find((entry) => entry.id === "country")!;
    expect(row).toMatchObject({ tag: "On this step", disabled: true });
    // The press is announced where a screen reader hears it, and focus stays on the field's row.
    expect(body(element).querySelector("[data-fields-status]")!.textContent).toBe("Country added to this step.");
    expect(body(element).activeElement).toBe(body(element).querySelector('[data-field-add="country"]'));
    // Not offered again: a press on it places nothing.
    body(element).querySelector<HTMLElement>('[data-field-add="country"]')!.click();
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName", "country"]);
    // One Undo takes the placement back (the bar's, which the Step view's history answers).
    element.builder!.undo();
    await until(() => groups(element).none?.some((entry) => entry.id === "country"));
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName"]);
  }, 30_000);

  it("carries a field to the canvas by drag: the payload is a new placement of the form field", async () => {
    const element = await onStep();
    await openPanel(element);
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true, composed: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), setDragImage: () => undefined } });
    body(element).querySelector('[data-field-add="email"]')!.dispatchEvent(event);
    const payload = JSON.parse([...data.values()][0]!) as { kind: string; component: { type: string; configuration: { componentId: string } } };
    expect(payload.kind).toBe("template-component");
    expect(payload.component.type).toBe("journey-field");
    expect(payload.component.configuration).toEqual({ componentId: "email" });
    // The field already on this step is not draggable.
    const here = body(element).querySelector('[data-field-add="fullName"]')!;
    expect(here.getAttribute("draggable")).toBeNull();
  }, 30_000);

  it("follows the step shown: moving to the next step marks that step's own fields as on this step", async () => {
    const element = await onStep();
    await openPanel(element);
    shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLElement>('[data-stepper-go="1"]')!.click();
    await until(() => groups(element).on?.find((row) => row.id === "subscribe")?.tag === "On this step");
    expect(groups(element).on!.find((row) => row.id === "fullName")).toMatchObject({ tag: "About you", disabled: false });
  }, 30_000);

  it("does not repaint for a draft typed elsewhere: a keystroke in the step's inspector changes nothing the panel draws", async () => {
    const element = await onStep();
    await openPanel(element);
    const mode = element.journeyMode!;
    const first = mode.controller.snapshot().children!.pages![0]!;
    mode.controller.select(first.id);
    let writes = 0;
    const watcher = new MutationObserver((records) => {
      writes += records.length;
    });
    watcher.observe(body(element), { childList: true, subtree: true, characterData: true });
    mode.controller.setDraftProperty(first.id, "title", "About you, again");
    mode.controller.setDraftProperty(first.id, "title", "About you, again and again");
    await Promise.resolve();
    expect(watcher.takeRecords()).toHaveLength(0);
    expect(writes).toBe(0);
    watcher.disconnect();
  }, 30_000);

  it("places one field per press and steps one entry per Ctrl+Z after the builder's language changed (its listeners are bound once, not per repaint)", async () => {
    const element = await onStep();
    await openPanel(element);
    const mode = element.journeyMode!;
    // A change of the builder's words writes the panel's shell again, twice.
    const fields = panel(element) as HTMLElement & { textLocale: string | undefined };
    fields.textLocale = "fr";
    fields.textLocale = undefined;
    body(element).querySelector<HTMLElement>('[data-field-add="country"]')!.click();
    await until(() => groups(element).on?.some((row) => row.id === "country"));
    body(element).querySelector<HTMLElement>('[data-field-add="email"]')!.click();
    await until(() => groups(element).on?.some((row) => row.id === "email"));
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName", "country", "email"]);
    const filter = body(element).querySelector<HTMLInputElement>("[data-fields-filter]")!;
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, composed: true }));
    await until(() => groups(element).none?.some((row) => row.id === "email"));
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName", "country"]);
  }, 30_000);

  it("offers no field on a Check answers step and on an ending, and says why", async () => {
    const block = journeyBlock();
    block.journeys![0]!.pages.push({ id: "check", kind: "review", title: "Check your answers", components: [] } as never, { id: "bye", kind: "exit", title: "Goodbye", components: [] } as never);
    const element = await onStep({ ...sampleDefinition(), journey: block });
    await openPanel(element);
    const mode = element.journeyMode!;
    const go = (): void => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!.querySelector<HTMLElement>('[data-stepper-go="1"]')!.click();
    go();
    go();
    await until(() => body(element).querySelector("[data-fields-refused]"));
    expect(body(element).querySelector("[data-fields-refused]")!.textContent).toBe("A Check answers step lists the answers. It asks no form field.");
    const country = body(element).querySelector<HTMLElement>('[data-field-add="country"]')!;
    expect(country.getAttribute("aria-disabled")).toBe("true");
    expect(country.getAttribute("draggable")).toBeNull();
    country.click();
    expect(mode.journey!.pages.map((page) => page.components ?? [])).toEqual([["fullName"], ["subscribe"], [], []]);
    go();
    // An ending: its words say ending, not exit.
    await until(() => body(element).querySelector("[data-fields-refused]")?.textContent === "An ending sends nothing, so a form field on it would never be checked.");
    body(element).querySelector<HTMLElement>('[data-field-add="country"]')!.click();
    expect(mode.journey!.pages.map((page) => page.components ?? [])).toEqual([["fullName"], ["subscribe"], [], []]);
  }, 30_000);

  it("makes one placement in one undo when a dragged field is dropped on the step", async () => {
    const element = await onStep();
    await openPanel(element);
    const mode = element.journeyMode!;
    const data = new Map<string, string>();
    const start = new Event("dragstart", { bubbles: true, composed: true }) as DragEvent;
    Object.defineProperty(start, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), setDragImage: () => undefined } });
    body(element).querySelector('[data-field-add="email"]')!.dispatchEvent(start);
    const payload = data.get(BUILDER_DRAG_MIME_TYPE)!;
    expect(payload).toBeDefined();
    // The step's own drop zone on the canvas: the page node the Step view draws as its root.
    const step = mode.controller.snapshot().children!.pages![0]!.id;
    const canvas = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    const form = canvas.querySelector<HTMLElement>("datum-form-renderer[data-preview]")!.shadowRoot!;
    await until(() => form.querySelector<HTMLElement>(`[data-dropzone][data-parent-id="${step}"]`));
    const zone = form.querySelector<HTMLElement>(`[data-dropzone][data-parent-id="${step}"]`);
    const drop = (type: string): Event => {
      const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: [BUILDER_DRAG_MIME_TYPE], effectAllowed: "copy", dropEffect: "none", getData: (mime: string) => (mime === BUILDER_DRAG_MIME_TYPE ? payload : ""), setData: () => undefined }
      });
      return event;
    };
    zone!.dispatchEvent(drop("dragover"));
    zone!.dispatchEvent(drop("drop"));
    await until(() => mode.journey!.pages[0]!.components!.includes("email"));
    expect(mode.journey!.pages[0]!.components!.filter((id) => id === "email")).toHaveLength(1);
    element.builder!.undo();
    await until(() => !mode.journey!.pages[0]!.components!.includes("email"));
    expect(mode.journey!.pages[0]!.components).toEqual(["fullName"]);
  }, 30_000);
});
