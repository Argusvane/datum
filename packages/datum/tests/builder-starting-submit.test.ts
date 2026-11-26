import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * A form the builder starts on holds one Submit button: the one File > New makes, and
 * the one a builder with neither `src` nor `definition` opens on. A definition the page supplies is
 * its own. The button is the clean starting point: not unsaved, not undoable away.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
});

const SUBMIT = { id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } };

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  setup?.(element);
  document.body.append(element);
  return element;
}

async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => element.builder!.shadowRoot!.querySelector<T>(selector)!;

/** Downloads go nowhere in jsdom: the anchor's click is swallowed, the object URL stubbed. */
function captureDownloads(): void {
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
}

/** The warnings the page hears with a Download of the form as it stands. */
function downloadWarnings(element: DatumFormBuilderElement): string[] {
  const heard: string[] = [];
  const listen = (event: Event): void => {
    heard.push(...((event as CustomEvent<{ warnings?: Array<{ message: string }> }>).detail.warnings ?? []).map((warning) => warning.message));
  };
  element.addEventListener("datum-builder-file-action", listen);
  q<HTMLButtonElement>(element, "[data-file-download]").click();
  element.removeEventListener("datum-builder-file-action", listen);
  return heard;
}

describe("the Submit button a new form starts with", () => {
  it("opens a builder given neither src nor definition on a form whose last child is one submit button", async () => {
    const element = mount();
    await ready(element);
    const content = element.definition.root.children?.content ?? [];
    expect(content).toEqual([SUBMIT]);
    expect(content.filter((child) => (child.configuration as { action?: string } | undefined)?.action === "submit")).toHaveLength(1);
  });

  it("gives File > New the same form, under the same button", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    q<HTMLButtonElement>(element, "[data-file-confirm-ok]").click();
    expect(element.definition.root.children?.content).toEqual([SUBMIT]);

    const bare = mount();
    await ready(bare);
    expect(element.definition.root).toEqual(bare.definition.root);
  });

  it("leaves a definition the page supplies as it is, whether or not it has a button", async () => {
    const withoutButton = { ...sampleDefinition(), root: { id: "root", type: "form", configuration: {}, children: { content: [] } } };
    const element = mount((el) => {
      el.definition = withoutButton;
    });
    await ready(element);
    expect(element.definition.root.children?.content).toEqual([]);

    const sample = sampleDefinition();
    const supplied = mount((el) => {
      el.definition = sample;
    });
    await ready(supplied);
    expect(supplied.definition.root).toEqual(sample.root);
  });

  it("is not unsaved when it opens or after New, and Undo does not remove the button", async () => {
    const element = mount();
    await ready(element);
    const changes: boolean[] = [];
    element.addEventListener("datum-builder-dirty-change", (event) => changes.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));
    const cue = q(element, "[data-save-cue]");
    const asksBeforeLeaving = (): boolean => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const controller = element.builder!.controller;

    expect(element.dirty).toBe(false);
    expect(element.hasUnsavedChanges()).toBe(false);
    expect(cue.hidden).toBe(true);
    expect(asksBeforeLeaving()).toBe(false);
    expect(controller.canUndo()).toBe(false);
    controller.undo();
    expect(element.definition.root.children?.content).toEqual([SUBMIT]);

    // File > New on it asks nothing and leaves the same clean start.
    q<HTMLButtonElement>(element, "[data-file-new]").click();
    expect(q(element, "[data-file-confirm]").hasAttribute("open")).toBe(false);
    expect(element.definition.root.children?.content).toEqual([SUBMIT]);
    expect(element.dirty).toBe(false);
    expect(cue.hidden).toBe(true);
    expect(asksBeforeLeaving()).toBe(false);
    expect(element.builder!.controller.canUndo()).toBe(false);
    element.builder!.controller.undo();
    expect(element.definition.root.children?.content).toEqual([SUBMIT]);
    expect(changes).toEqual([]);

    // The first thing added is the first unsaved edit, and Undo goes back to the start, button and all.
    element.builder!.controller.requestAdd("text");
    expect(element.dirty).toBe(true);
    element.builder!.controller.undo();
    expect(element.definition.root.children?.content).toEqual([SUBMIT]);
    expect(element.dirty).toBe(false);
  });

  it("downloads without the no-Submit warning, and warns once the button is deleted", async () => {
    captureDownloads();
    const element = mount();
    await ready(element);
    expect(downloadWarnings(element)).toEqual([]);

    element.builder!.controller.remove("submit");
    expect(element.definition.root.children?.content).toEqual([]);
    const warnings = downloadWarnings(element);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("This form has no Submit button, so nobody can send it.");
  });
});
