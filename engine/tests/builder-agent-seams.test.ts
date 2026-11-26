// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { CANVAS_CHROME_STYLES } from "../form-engine/builder/web-component/builder-shared.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { extendBinding } from "../form-engine/render/live/contract.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";

/*
 * The shell's seams for the builder agent tools:
 * reveal, the timed highlight, Try it and a panel's presence, reached by the agent's element host
 * because the canvas is private. jsdom applies no shadow CSS, so the highlight is asserted on the
 * attribute it sets and the rule's text, never on a computed outline.
 */

defineDatumBuilderElement();

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } }
      ]
    }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const canvasOf = (element: DatumBuilderElement): DatumBuilderCanvasElement => element.shadowRoot!.querySelector(".canvas") as DatumBuilderCanvasElement;
const boxes = (element: DatumBuilderElement, id: string): HTMLElement[] =>
  [...(canvasOf(element).previewRoot()?.querySelectorAll<HTMLElement>(".db-node[data-component-id]") ?? [])].filter((node) => node.dataset.componentId === id);
const touched = (element: DatumBuilderElement): string[] =>
  [...(canvasOf(element).previewRoot()?.querySelectorAll<HTMLElement>("[data-agent-touched]") ?? [])].map((node) => node.dataset.componentId ?? node.dataset.containerId ?? "");

/* The same two fields on two steps: fullName on the first, email on the second. */
function stepsRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        {
          id: "pages",
          type: "steps",
          configuration: {},
          children: {
            content: [
              { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] } },
              { id: "contact", type: "step", configuration: { label: "Contact" }, children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] } }
            ]
          }
        }
      ]
    }
  };
}

async function mount(setup?: (element: DatumBuilderElement) => void, initialRoot: ComponentNode = formRoot()): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot, componentTypes: [{ type: "text", label: "Text" }] };
  setup?.(element);
  document.body.append(element);
  await until(() => boxes(element, "fullName").length > 0);
  return element;
}

describe("revealComponent", () => {
  it("reaches the canvas renderer's revealComponent", async () => {
    const element = await mount();
    const renderer = canvasOf(element).previewRoot()!.host as HTMLElement & { revealComponent(id: string): void };
    const reveal = vi.spyOn(renderer, "revealComponent");
    element.revealComponent("email");
    expect(reveal).toHaveBeenCalledWith("email");
  });

  it("opens the step the component sits on and moves no focus", async () => {
    // The reveal is deferred behind the renderer's rebuild, and a step it opens is the one place
    // focus could move (a step's heading): so the component sits on a later step, and focus is
    // only checked once that step is showing.
    const element = await mount(undefined, stepsRoot());
    const stepPanel = (id: string): HTMLElement | undefined =>
      [...(canvasOf(element).previewRoot()?.querySelectorAll<HTMLElement>("[data-step-panel]") ?? [])].find((panel) => panel.dataset.stepPanel === id);
    await until(() => stepPanel("contact") !== undefined);
    expect(stepPanel("contact")!.hidden).toBe(true);
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    element.revealComponent("email");
    await until(() => stepPanel("contact")?.hidden === false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(outside);
  });

  it("does nothing before the shell has a canvas", () => {
    const element = document.createElement("datum-builder") as DatumBuilderElement;
    expect(() => element.revealComponent("email")).not.toThrow();
    expect(() => element.highlightComponents(["email"])).not.toThrow();
    expect(element.trying).toBe(false);
    expect(element.setTrying(true)).toBe(false);
  });
});

describe("highlightComponents", () => {
  it("marks the touched components' boxes in the preview root and takes the mark away after 1 500 ms", async () => {
    const element = await mount();
    vi.useFakeTimers();
    element.highlightComponents(["email"]);
    expect(touched(element)).toEqual(["email"]);
    expect(boxes(element, "email")[0]?.getAttribute("data-agent-touched")).toBe("");
    vi.advanceTimersByTime(1499);
    expect(touched(element)).toEqual(["email"]);
    vi.advanceTimersByTime(1);
    expect(touched(element)).toEqual([]);
  });

  it("keeps the mark on a box a redraw keeps", async () => {
    const element = await mount();
    element.highlightComponents(["email"], 60_000);
    const before = boxes(element, "email")[0];
    // A redraw the person's own change causes patches the boxes in place.
    element.controller.setShowHiddenComponents(!element.controller.showHiddenComponents());
    await (canvasOf(element).previewRoot()!.host as HTMLElement & { painted(): Promise<void> }).painted();
    expect(boxes(element, "email")[0]).toBe(before);
    expect(touched(element)).toEqual(["email"]);
  });

  it("marks the boxes again, once, when a draw inside the window makes them anew", async () => {
    const element = await mount((builder) => {
      builder.options = {
        availableBindings: [
          { id: "datum", label: "Datum" },
          { id: "other", label: "Other", binding: extendBinding(createDatumBinding(), { id: "other", label: "Other" }) }
        ]
      };
    });
    element.highlightComponents(["email"], 60_000);
    expect(touched(element)).toEqual(["email"]);
    const before = boxes(element, "email")[0];
    // Another binding mounts the form again: every box is made afresh.
    element.controller.setBindingId("other");
    await until(() => boxes(element, "email")[0] !== before && boxes(element, "email")[0]?.isConnected);
    await until(() => touched(element).includes("email"));
    expect(touched(element)).toEqual(["email"]);
    // Once only: a second fresh draw inside the window is not marked again.
    const second = boxes(element, "email")[0];
    element.controller.setBindingId("datum");
    await until(() => boxes(element, "email")[0] !== second && boxes(element, "email")[0]?.isConnected);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(touched(element)).toEqual([]);
  });

  it("restarts on a second call: the first call's marks go, the second's stay for their own window", async () => {
    const element = await mount();
    vi.useFakeTimers();
    element.highlightComponents(["fullName"]);
    vi.advanceTimersByTime(1000);
    element.highlightComponents(["email"]);
    expect(touched(element)).toEqual(["email"]);
    vi.advanceTimersByTime(1000);
    expect(touched(element)).toEqual(["email"]);
    vi.advanceTimersByTime(500);
    expect(touched(element)).toEqual([]);
  });

  it("ends with the builder: taken off the page, no timer, no watch and no mark is left", async () => {
    const element = await mount();
    const root = canvasOf(element).previewRoot()!;
    vi.useFakeTimers();
    element.highlightComponents(["email"]);
    expect(touched(element)).toEqual(["email"]);
    const pending = vi.getTimerCount();
    element.remove();
    expect(vi.getTimerCount()).toBe(pending - 1);
    expect(root.querySelectorAll("[data-agent-touched]").length).toBe(0);
    // Its watch is gone too: boxes drawn after the removal are not marked.
    const box = document.createElement("div");
    box.className = "db-node";
    box.dataset.componentId = "email";
    root.append(box);
    await vi.advanceTimersByTimeAsync(0);
    expect(box.hasAttribute("data-agent-touched")).toBe(false);
  });
});

describe("trying and setTrying", () => {
  it("follows Try it on and off", async () => {
    const element = await mount();
    expect(element.trying).toBe(false);
    expect(element.setTrying(true)).toBe(true);
    expect(element.trying).toBe(true);
    expect(canvasOf(element).previewing).toBe(true);
    expect(element.setTrying(false)).toBe(true);
    expect(element.trying).toBe(false);
  });

  it("with an unapplied edit, answers false and asks the person first, as Try it does", async () => {
    const element = await mount();
    const ctrl = element.controller;
    ctrl.select("fullName");
    ctrl.setDraftProperty("fullName", "label", "Your name");
    expect(element.setTrying(true)).toBe(false);
    expect(element.trying).toBe(false);
    expect(ctrl.unsavedChangesPrompt()).toEqual({ componentId: "fullName", action: "leave" });
    // The person keeps editing: Try it stays off. Discarding runs it.
    ctrl.answerUnsavedChangesPrompt("discard");
    expect(element.trying).toBe(true);
  });
});

describe("tryable", () => {
  it("answers whether the person has Try it here, and setTrying never turns it on where they do not", async () => {
    const element = await mount();
    expect(element.tryable).toBe(true);
    element.workspace = "logic";
    await until(() => element.workspace === "logic");
    expect(element.tryable).toBe(false);
    expect(element.setTrying(true)).toBe(false);
    expect(element.trying).toBe(false);
    expect(canvasOf(element).previewing).toBe(false);
    expect(element.shadowRoot!.querySelector("[data-trying]")).toBeNull();
    // Back on the Form workspace, Try it runs again.
    element.workspace = "form";
    await until(() => element.tryable);
    expect(element.setTrying(true)).toBe(true);
    expect(element.trying).toBe(true);
  });
});

describe("panelHidden", () => {
  it("answers for a panel the features list leaves off and for one hidden-panels leaves off", async () => {
    const element = await mount((el) => {
      el.setAttribute("features", "minimal");
      el.setAttribute("hidden-panels", "outline");
    });
    expect(element.panelHidden("variables")).toBe(true);
    expect(element.panelHidden("outline")).toBe(true);
    expect(element.panelHidden("form")).toBe(false);
    // A host's own panel is never the shell's to leave off.
    expect(element.panelHidden("my-host-panel")).toBe(false);
  });
});

describe("the canvas highlight rule", () => {
  // The rule's selector list, from its first selector to its block.
  const start = CANVAS_CHROME_STYLES.indexOf("  [data-agent-touched],");
  const open = CANVAS_CHROME_STYLES.indexOf("{", start);
  const selectors = CANVAS_CHROME_STYLES.slice(start, open);
  const block = CANVAS_CHROME_STYLES.slice(open, CANVAS_CHROME_STYLES.indexOf("}", open));
  const at = (rule: string): number => {
    const index = CANVAS_CHROME_STYLES.indexOf(rule);
    expect(index, rule).toBeGreaterThan(-1);
    return index;
  };

  it("draws the mark in the studio's focus colour", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("outline: 2px solid var(--db-focus)");
  });

  it("wins over every other outline a box can wear: selection, hover, a container's ring, a hidden component's ring", () => {
    // Later than each, at equal or greater weight (jsdom applies no shadow CSS, so order and selectors are asserted).
    for (const rule of [".db-selected {", ".db-node:hover {", ".db-node--container:hover {", ".db-node--container.db-selected,", ".db-node--hidden:not(.db-selected):not(:hover) {"]) {
      expect(start, rule).toBeGreaterThan(at(rule));
    }
    expect(selectors).toContain(".db-node[data-agent-touched]");
    // The hidden ring weighs (0,3,0); the highlight's hidden form weighs (0,4,0).
    expect(selectors).toContain(".db-node--hidden[data-agent-touched]:not(.db-selected):not(:hover)");
  });
});

describe("the Tests chunk's words", () => {
  it("are exported by the chunk entry beside the runner", async () => {
    const chunk = await import("../form-engine/builder/web-component/builder-tests-panel.js");
    expect(typeof chunk.createTestsRunner).toBe("function");
    expect(typeof chunk.createTestsWords).toBe("function");
    expect(typeof chunk.createTestsNaming).toBe("function");
  });
});
