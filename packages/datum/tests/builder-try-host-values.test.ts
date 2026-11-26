import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { DatumBuilderElement, type ComponentNode, type DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, JourneyConfiguration, TryItServerChecks } from "@argusvane/datum-engine";

import { modesReady, until } from "./helpers.js";

/**
 * Host values in Try it's Settings: what a rule reads under `host.` while the form is previewed.
 * Preview state: the form never holds it, nothing is undoable, and the server's checks are given
 * the same values.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Sample" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "adminNote", type: "text", configuration: { label: "Admin note" }, rules: { visibleWhen: 'host.role = "admin"' } }
      ]
    }
  };
}

const canvasEl = (element: DatumBuilderElement) => element.shadowRoot!.querySelector("datum-builder-canvas") as HTMLElement & { previewing: boolean };
const renderer = (element: DatumBuilderElement) => canvasEl(element).shadowRoot!.querySelector("[data-preview]") as HTMLElement & { shadowRoot: ShadowRoot };
const section = (element: DatumBuilderElement): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>("[data-settings-panel] [data-settings-host]")!;
const box = (element: DatumBuilderElement): HTMLTextAreaElement => section(element).querySelector<HTMLTextAreaElement>("[data-host-values]")!;
const problem = (element: DatumBuilderElement): HTMLElement => section(element).querySelector<HTMLElement>("[data-host-problem]")!;
const shown = (element: DatumBuilderElement, id: string): boolean => renderer(element).shadowRoot.querySelector(`[data-component-id="${id}"]`) !== null;

/** What the author does: types into the box, then leaves it (a `change`). */
function commit(element: DatumBuilderElement, text: string): void {
  const control = box(element);
  control.value = text;
  control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

/** The form on the canvas, tried: the canvas while editing draws a field a rule hides, as a hidden one. */
async function mount(): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot() };
  document.body.append(element);
  await until(() => renderer(element)?.shadowRoot?.querySelector('[data-component-id="fullName"]'));
  canvasEl(element).previewing = true;
  await until(() => !canvasEl(element).shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!.hidden);
  return element;
}

describe("Host values in Try it's Settings", () => {
  it("sits between Submitting in Try it and Data sources, with its hint and an example", async () => {
    const element = await mount();
    const sections = [...element.shadowRoot!.querySelectorAll<HTMLElement>("[data-settings-panel] .settings-section")].map((entry) => entry.querySelector("h3")!.textContent);
    expect(sections).toEqual(["Language", "Submitting in Try it", "Host values", "Data sources"]);
    expect(box(element).placeholder).toBe('{ "role": "admin" }');
    expect(box(element).value).toBe("");
    expect(problem(element).hidden).toBe(true);
    // The form has a rule reading host values, so the line saying so is drawn.
    expect(section(element).querySelector<HTMLElement>("[data-settings-host-reads]")!.hidden).toBe(false);
  });

  it("says nothing of host values reads when no rule reads one", async () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    element.options = {
      initialRoot: { id: "root", type: "form", configuration: { title: "Plain" }, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] } }
    };
    document.body.append(element);
    await until(() => renderer(element)?.shadowRoot?.querySelector('[data-component-id="fullName"]'));
    expect(section(element).querySelector<HTMLElement>("[data-settings-host-reads]")!.hidden).toBe(true);
  });

  it("shows a host-gated field once the values say so, and hides it again when the box is cleared", async () => {
    const element = await mount();
    expect(shown(element, "adminNote")).toBe(false);
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    expect(problem(element).hidden).toBe(true);
    expect(element.controller.tryHostContext()).toEqual({ role: "admin" });
    commit(element, '{ "role": "visitor" }');
    await until(() => !shown(element, "adminNote"));
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    commit(element, "   ");
    await until(() => !shown(element, "adminNote"));
    expect(element.controller.tryHostContext()).toBeUndefined();
    expect(problem(element).hidden).toBe(true);
  });

  it("keeps the answers typed while the values change", async () => {
    const element = await mount();
    const preview = (canvasEl(element) as unknown as { previewRuntime(): { setValue(path: string, value: unknown): void; state(): { values: Record<string, unknown> } } }).previewRuntime();
    const input = renderer(element).shadowRoot.querySelector<HTMLInputElement>('[data-component-id="fullName"] input')!;
    input.value = "Ada Lovelace";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => preview.state().values.fullName === "Ada Lovelace");
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    expect(preview.state().values.fullName).toBe("Ada Lovelace");
  });

  it("says a problem under the box for text that is not JSON, and keeps the last good values", async () => {
    const element = await mount();
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    commit(element, '{ "role": ');
    expect(problem(element).hidden).toBe(false);
    expect(problem(element).textContent).toContain("not valid JSON");
    expect(box(element).getAttribute("aria-invalid")).toBe("true");
    // What was typed stays in the box; the controls are not disabled; the last good values stay applied.
    expect(box(element).value).toBe('{ "role": ');
    expect(box(element).disabled).toBe(false);
    expect(element.controller.tryHostContext()).toEqual({ role: "admin" });
    expect(shown(element, "adminNote")).toBe(true);
    // Mending the text takes the problem away.
    commit(element, '{ "role": "visitor" }');
    expect(problem(element).hidden).toBe(true);
    await until(() => !shown(element, "adminNote"));
  });

  it("refuses JSON that is not an object the same way", async () => {
    const element = await mount();
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    for (const text of ['["admin"]', '"admin"', "42", "null"]) {
      commit(element, text);
      expect(problem(element).hidden).toBe(false);
      expect(problem(element).textContent).toContain("JSON object");
      expect(element.controller.tryHostContext()).toEqual({ role: "admin" });
    }
  });

  it("writes nothing into the form: no edit is announced, the definition is as it was, Undo has nothing", async () => {
    const element = await mount();
    const before = JSON.stringify(element.controller.snapshot());
    const reasons: string[] = [];
    element.addEventListener("builder-change", (event) => reasons.push((event as CustomEvent<{ reason: string }>).detail.reason));
    const undoable = element.controller.canUndo();
    commit(element, '{ "role": "admin" }');
    await until(() => shown(element, "adminNote"));
    commit(element, "{");
    commit(element, "");
    expect(JSON.stringify(element.controller.snapshot())).toBe(before);
    expect(reasons.filter((reason) => reason !== "preview")).toEqual([]);
    expect(element.controller.canUndo()).toBe(undoable);
  });

  it("is session state: the box shows what the controller holds, even when it was set elsewhere", async () => {
    const element = await mount();
    element.controller.setTryHostContext({ role: "admin" });
    await until(() => box(element).value.includes("admin"));
    expect(JSON.parse(box(element).value)).toEqual({ role: "admin" });
    await until(() => shown(element, "adminNote"));
    element.controller.setTryHostContext(undefined);
    await until(() => box(element).value === "");
  });

  it("leaves the box alone while it has the caret", async () => {
    const element = await mount();
    const control = box(element);
    // jsdom refuses focus inside the closed settings drawer, so the box is said to hold it.
    Object.defineProperty(element.shadowRoot!, "activeElement", { configurable: true, get: () => control });
    control.value = '{ "ro';
    control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    // A repaint caused by anything else (a change of the form) leaves what is being typed.
    element.controller.setTryHostContext({ role: "admin" });
    expect(control.value).toBe('{ "ro');
  });

  it("is in Try it as well: the field shows while the form is tried, and the server's checks are given the values", async () => {
    const element = await mount();
    const requests: Array<Record<string, unknown> | undefined> = [];
    const checks: TryItServerChecks = {
      label: "Test sandbox",
      run: async ({ hostContext }) => {
        requests.push(hostContext as Record<string, unknown> | undefined);
        return { errors: [] };
      }
    };
    element.serverChecks = checks;
    commit(element, '{ "role": "admin", "site": { "id": 7 } }');
    const panel = canvasEl(element).shadowRoot!.querySelector<HTMLElement>("[data-try-panel]")!;
    await until(() => panel.querySelector("[data-try-server]"));
    await until(() => shown(element, "adminNote"));
    panel.querySelector<HTMLInputElement>("[data-try-server]")!.click();
    await until(() => requests.length > 0);
    expect(requests.at(-1)).toEqual({ role: "admin", site: { id: 7 } });
    // With no values, the request carries none.
    commit(element, "");
    await until(() => !shown(element, "adminNote"));
    panel.querySelector<HTMLButtonElement>("[data-try-check]")!.click();
    await until(() => requests.length > 1);
    expect(requests.at(-1)).toBeUndefined();
  });
});

/**
 * The Journeys mode's preview runs a runtime of its own: it starts with the host values Try it's
 * Settings hold, and does not wait for a paint to be given them.
 */
describe("Host values in the Journeys preview", () => {
  function journeyDefinition(): FormDefinition {
    const journey = {
      journeys: [{ id: "intake", name: "Intake", pages: [{ id: "about", title: "About you", components: ["fullName", "adminNote"] }] }],
      defaultJourneyId: "intake",
      opensAs: "form"
    } as JourneyConfiguration;
    return { id: "host-journey", version: "1.0.0", schemaVersion: "1", root: formRoot(), journey };
  }

  it("shows a host-gated field with values set before Journeys is entered", async () => {
    const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    element.definition = journeyDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    await modesReady(element);
    const controller = (element.builder as unknown as { controller: DatumBuilderElement["controller"] }).controller;
    controller.setTryHostContext({ role: "admin" });
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    element.journeyMode!.view = "step";
    const canvas = element.builder!.shadowRoot!.querySelector("datum-builder-canvas")!;
    await until(() => (canvas as HTMLElement & { previewRoot(): ShadowRoot | undefined }).previewRoot()?.querySelector("[data-journey-heading]"));
    canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-it]")!.click();
    const triedRoot = (): ShadowRoot | null | undefined => canvas.shadowRoot!.querySelector<HTMLElement>("datum-form-renderer")?.shadowRoot;
    await until(() => canvas.shadowRoot!.querySelector("[data-try-panel] .try-card[data-try-journey]") && triedRoot()?.querySelector("[data-journey-heading]"));
    expect(triedRoot()!.querySelector('[data-component-id="adminNote"]')).not.toBeNull();
    controller.setTryHostContext(undefined);
    await until(() => triedRoot()?.querySelector('[data-component-id="adminNote"]') === null);
  });

  it("starts the engine's own preview runtime with the values it is given", async () => {
    const { createEnginePreviewRuntime } = await import("../../../engine/form-engine/builder/journey-designer/journey-preview.js");
    const definition = journeyDefinition();
    const request = {
      journeyConfiguration: () => definition.journey,
      journeyId: "intake",
      locale: "en",
      root: definition.root,
      localization: undefined
    };
    expect(createEnginePreviewRuntime(request, { hostContext: { role: "admin" } }).hostContext()).toEqual({ role: "admin" });
    expect(createEnginePreviewRuntime(request).hostContext()).toBeUndefined();
  });
});
