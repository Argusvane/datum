import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, JourneyConfiguration } from "@argusvane/datum-engine";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/*
 * The Journeys workspace's shell and Step view: the canvas keeps clear of the open drawer and the inspector in the Step view
 * (the geometry itself is checked in Chrome; here, the attributes and the rule it rests on), a
 * step's inspector tab says Step, a Check answers or exit step draws no "Nothing asked" hint, the
 * map leaves no empty canvas bar, and the palette's groups are the Form workspace's.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** `intake`: a questions step with the name, an empty questions step, an exit step, and a Check answers step last. */
function journeyBlock(): JourneyConfiguration {
  return JSON.parse(
    JSON.stringify({
      journeys: [
        {
          id: "intake",
          name: "Intake",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "blank", title: "Nothing yet", components: [] },
            { id: "stop", title: "You cannot apply", kind: "exit", components: [] },
            { id: "check", title: "Check your answers", kind: "review", components: [] }
          ]
        }
      ],
      defaultJourneyId: "intake",
      opensAs: "form"
    })
  ) as JourneyConfiguration;
}

async function onJourneys(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("pdf", "off");
  element.definition = { ...sampleDefinition(), journey: journeyBlock() } as FormDefinition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await modesReady(element);
  element.mode = "journeys";
  await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>(".wrap")!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
const sheet = (element: DatumFormBuilderElement): ShadowRoot | null | undefined => canvas(element).querySelector("datum-form-renderer")?.shadowRoot;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector(".body > datum-builder-properties")!.shadowRoot!;
const firstTab = (element: DatumFormBuilderElement): string | undefined =>
  inspector(element).querySelector<HTMLElement>('[data-inspector-tab="properties"]')?.textContent?.trim();

function viewButton(element: DatumFormBuilderElement, view: "map" | "step"): HTMLElement {
  return shell(element).querySelector<HTMLElement>(`[data-mode-actions] [data-journey-views] [data-journey-view="${view}"]`)!;
}

async function toStep(element: DatumFormBuilderElement): Promise<void> {
  viewButton(element, "step").click();
  await until(() => element.journeyMode?.view === "step");
}

/** Shows the step written as `pageId` and selects it on the journey's controller. */
async function showStep(element: DatumFormBuilderElement, pageId: string): Promise<string> {
  const controller = element.journeyMode!.controller;
  const node = controller.snapshot().children!.pages!.find((page) => (page.configuration as { pageId?: string }).pageId === pageId)!;
  controller.select(node.id);
  await until(() => controller.selectedComponentId() === node.id);
  return node.id;
}

const emptyPrompt = (element: DatumFormBuilderElement): HTMLElement => canvas(element).querySelector<HTMLElement>("[data-canvas-empty-root]")!;
const hintTexts = (element: DatumFormBuilderElement): string[] =>
  [...(sheet(element)?.querySelectorAll<HTMLElement>(".db-empty") ?? [])].map((hint) => hint.textContent!.trim());

describe("the Journeys workspace's Step view and shell", () => {
  it("keeps the Step view's canvas clear of the open drawer and the inspector, the Form fields panel as the palette, and leaves the map and the Form workspace as they were", async () => {
    const element = await onJourneys();
    const styles = [...shell(element).querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    // The rule the geometry rests on: the room is worked out on the body from each drawer's reach, the canvas takes it as its margins.
    expect(styles).toContain('.wrap[data-workspace="journeys"][data-drawer-open]:not([data-surface]):not([data-overview]):not([data-trying]):not([data-narrow]):not([data-phone]) .body');
    expect(styles).toContain("--shell-step-start: calc(min(var(--db-side-w), calc(100% - var(--db-strip-w) - 3 * var(--db-gap) - 48px)) + var(--db-gap));");
    expect(styles).toContain("margin-inline: var(--shell-step-start, 0px) var(--shell-step-end, 0px);");

    // On the map (a surface) the rule does not hold: the map keeps the shell's drawer contract.
    expect(element.journeyMode!.view).toBe("map");
    expect(wrap(element).dataset.workspace).toBe("journeys");
    expect(wrap(element).hasAttribute("data-surface")).toBe(true);

    await toStep(element);
    await until(() => !wrap(element).hasAttribute("data-surface"));
    element.builder!.panel = "fields";
    await until(() => wrap(element).dataset.openPanel === "fields");
    // The attributes the rule reads, as the Step view with the Form fields panel open sets them.
    expect(wrap(element).dataset.workspace).toBe("journeys");
    expect(wrap(element).hasAttribute("data-drawer-open")).toBe(true);
    expect(wrap(element).hasAttribute("data-surface")).toBe(false);
    expect(wrap(element).hasAttribute("data-overview")).toBe(false);
    element.builder!.panel = "components";
    await until(() => wrap(element).dataset.openPanel === "components");
    expect(wrap(element).hasAttribute("data-drawer-open")).toBe(true);

    // The Form workspace is another workspace: none of it applies there.
    element.builder!.workspace = "form";
    await until(() => wrap(element).dataset.workspace === "form");
  }, 30_000);

  it("calls a step's first inspector tab Step, on the map and in the Step view, and a field's Field", async () => {
    const element = await onJourneys();
    await showStep(element, "about");
    await until(() => firstTab(element) !== undefined);
    expect(firstTab(element)).toBe("Step");
    await toStep(element);
    await showStep(element, "check");
    await until(() => firstTab(element) === "Step");
    // A form field is still a Field (the Form workspace's inspector).
    element.builder!.workspace = "form";
    await until(() => wrap(element).dataset.workspace === "form");
    element.builder!.activeController.select("fullName");
    await until(() => firstTab(element) === "Field");
  }, 30_000);

  it("draws the empty-step hint on an empty questions step only, never on a Check answers or an exit step", async () => {
    const element = await onJourneys();
    await toStep(element);
    await showStep(element, "blank");
    await until(() => !emptyPrompt(element).hidden);
    expect(emptyPrompt(element).textContent).toContain("Nothing asked on this step yet");

    await showStep(element, "check");
    await until(() => sheet(element)?.querySelector("[data-journey-review]") !== null && emptyPrompt(element).hidden);
    expect(hintTexts(element).some((text) => text.includes("Nothing asked"))).toBe(false);

    await showStep(element, "stop");
    await until(() => emptyPrompt(element).hidden && (sheet(element)?.textContent ?? "").includes("You cannot apply"));
    expect(hintTexts(element).some((text) => text.includes("Nothing asked"))).toBe(false);
    expect(emptyPrompt(element).hidden).toBe(true);
  }, 30_000);

  it("puts the canvas bar away on the map, where nothing in it shows, and keeps it in the Step view and the Form workspace", async () => {
    const element = await onJourneys();
    const bar = (): HTMLElement => canvas(element).querySelector<HTMLElement>("[data-canvas-bar]")!;
    expect(element.journeyMode!.view).toBe("map");
    await until(() => bar().hidden);
    // Its zone stays; the room kept above the page for the bar goes with it, so the map starts at the top.
    expect(canvas(element).querySelector<HTMLElement>("[data-canvas-bar-zone]")!.hidden).toBe(false);
    expect(canvas(element).querySelector(".panel--canvas")!.hasAttribute("data-canvas-bar-shown")).toBe(false);

    await toStep(element);
    await until(() => !bar().hidden);
    expect(canvas(element).querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden).toBe(false);
    expect(canvas(element).querySelector(".panel--canvas")!.hasAttribute("data-canvas-bar-shown")).toBe(true);

    element.builder!.workspace = "form";
    await until(() => wrap(element).dataset.workspace === "form" && !bar().hidden);
    expect(canvas(element).querySelector<HTMLElement>("[data-try-it]")!.hidden).toBe(false);
  }, 30_000);
});
