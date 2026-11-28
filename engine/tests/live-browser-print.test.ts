// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { stepsFeature } from "../form-engine/render/live/steps.js";
import { createTabsFeature } from "../form-engine/render/live/tabs.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { definitionOf, mounted, quiet, runtimeOf, unmountAll } from "./live-chrome-harness.js";

/*
 * The page's own print (the browser's Print command): the live form draws its tabs and steps
 * flat and headed from the window's `beforeprint` to its `afterprint`, synchronously inside the
 * event, so the printed page has the flat layout. A print on another window (the print frame's)
 * leaves the form as it is.
 */

afterEach(unmountAll);

const pagedForm = () =>
  definitionOf([
    {
      id: "t",
      type: "tabs",
      configuration: { label: "Sections", tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
      children: {
        one: [{ id: "a", type: "text", configuration: { label: "A" } }],
        two: [{ id: "b", type: "text", configuration: { label: "B" } }]
      }
    },
    {
      id: "journey",
      type: "steps",
      configuration: {},
      children: {
        content: [
          { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
          { id: "where", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] } }
        ]
      }
    }
  ]);

const features = () => [createTabsFeature(), stepsFeature()];

/** Whether the tabs and the steps are drawn flat: no tab strip, no step indicator or Continue, every panel shown and headed. */
function layout(root: ShadowRoot): { tabs: "strip" | "flat"; steps: "paged" | "flat" } {
  const strip = root.querySelector('[role="tablist"]') !== null;
  const tabSections = root.querySelectorAll(".datum-form__tabs-section").length;
  const indicator = root.querySelector(".datum-form__step-indicator") !== null || root.querySelector("[data-step-next]") !== null;
  const stepPanels = Array.from(root.querySelectorAll<HTMLElement>(".datum-form__step-panel")).filter((panel) => !panel.hidden).length;
  return {
    tabs: !strip && tabSections === 2 ? "flat" : "strip",
    steps: !indicator && stepPanels === 2 ? "flat" : "paged"
  };
}

describe("live form: the page's own print", () => {
  it("draws tabs and steps flat and headed inside beforeprint, and pages them again on afterprint", async () => {
    quiet();
    const m = await mounted(pagedForm(), { features: features() });
    expect(layout(m.root)).toEqual({ tabs: "strip", steps: "paged" });

    window.dispatchEvent(new Event("beforeprint"));
    // No wait: the print snapshot is taken once the event's listeners return.
    expect(m.live().printing()).toBe(true);
    expect(layout(m.root)).toEqual({ tabs: "flat", steps: "flat" });
    expect(Array.from(m.root.querySelectorAll(".datum-form__tabs-section .datum-form__panel-title")).map((h) => h.textContent)).toEqual(["One", "Two"]);

    window.dispatchEvent(new Event("afterprint"));
    expect(m.live().printing()).toBe(false);
    expect(layout(m.root)).toEqual({ tabs: "strip", steps: "paged" });
  });

  it("follows print media where the browser fires no beforeprint", async () => {
    quiet();
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      matches: false,
      media: "print",
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)
    };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    const m = await mounted(pagedForm(), { features: features() });
    expect(listeners.size).toBe(1);
    const fire = (matches: boolean): void => {
      for (const listener of [...listeners]) {
        listener({ matches, media: "print" } as MediaQueryListEvent);
      }
    };
    fire(true);
    expect(layout(m.root)).toEqual({ tabs: "flat", steps: "flat" });
    // beforeprint and the media change both come where a browser has both: one print state.
    window.dispatchEvent(new Event("beforeprint"));
    fire(false);
    expect(layout(m.root)).toEqual({ tabs: "strip", steps: "paged" });
    window.dispatchEvent(new Event("afterprint"));
    expect(m.live().printing()).toBe(false);

    m.form.unmount();
    expect(listeners.size).toBe(0);
  });

  it("stops listening on unmount", async () => {
    quiet();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const m = await mounted(pagedForm(), { features: features() });
    const printListeners = added.mock.calls.filter(([type]) => type === "beforeprint" || type === "afterprint");
    expect(printListeners.map(([type]) => type).sort()).toEqual(["afterprint", "beforeprint"]);
    m.form.unmount();
    for (const [type, listener] of printListeners) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
    // Nothing is drawn, and nothing throws, when the page prints after the form has gone.
    expect(() => window.dispatchEvent(new Event("beforeprint"))).not.toThrow();
    expect(m.root.childElementCount).toBe(0);
    window.dispatchEvent(new Event("afterprint"));
  });

  it("leaves the form as it is for a print on another window, such as the print frame's", async () => {
    quiet();
    const m = await mounted(pagedForm(), { features: features() });
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.contentWindow!.dispatchEvent(new Event("beforeprint"));
    expect(m.live().printing()).toBe(false);
    expect(layout(m.root)).toEqual({ tabs: "strip", steps: "paged" });
    frame.contentWindow!.dispatchEvent(new Event("afterprint"));
  });

  it("takes back only the print state it set", async () => {
    quiet();
    const m = await mounted(pagedForm(), { features: features() });
    m.live().setPrinting(true);
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("afterprint"));
    expect(m.live().printing()).toBe(true);
    expect(layout(m.root)).toEqual({ tabs: "flat", steps: "flat" });
  });

  it("does nothing around the page's print with browserPrint false", async () => {
    quiet();
    const m = await mounted(pagedForm(), { features: features(), browserPrint: false });
    window.dispatchEvent(new Event("beforeprint"));
    expect(m.live().printing()).toBe(false);
    expect(layout(m.root)).toEqual({ tabs: "strip", steps: "paged" });
    window.dispatchEvent(new Event("afterprint"));
  });
});

describe("<datum-form-renderer>: the page's own print", () => {
  async function rendered(features?: string): Promise<{ element: DatumFormRendererElement; root: ShadowRoot }> {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    if (features !== undefined) {
      element.setAttribute("features", features);
    }
    element.runtime = runtimeOf(pagedForm());
    document.body.append(element);
    const root = element.shadowRoot!;
    for (let tries = 0; tries < 100 && root.querySelector('[role="tablist"]') === null; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { element, root };
  }

  it("draws the form flat for the page's print, and as on screen under a features list without print", async () => {
    quiet();
    const drawn = await rendered();
    expect(layout(drawn.root)).toEqual({ tabs: "strip", steps: "paged" });
    window.dispatchEvent(new Event("beforeprint"));
    expect(layout(drawn.root)).toEqual({ tabs: "flat", steps: "flat" });
    window.dispatchEvent(new Event("afterprint"));
    expect(layout(drawn.root)).toEqual({ tabs: "strip", steps: "paged" });
    drawn.element.remove();

    const left = await rendered("minimal");
    expect(layout(left.root)).toEqual({ tabs: "strip", steps: "paged" });
    window.dispatchEvent(new Event("beforeprint"));
    expect(layout(left.root)).toEqual({ tabs: "strip", steps: "paged" });
    window.dispatchEvent(new Event("afterprint"));
  });
});
