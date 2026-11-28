import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * A mode's worded actions live in the canvas's toolbar: the primary one an accent pill
 * before Try it, the others worded tools before the zoom, which a narrow canvas folds behind its
 * one "…" button into a card, the buttons moved (never cloned). The top bar keeps only a mode's
 * views switch (navigation); on a phone every action is in the menu drawer. jsdom lays nothing
 * out and evaluates no container query, so these read the attributes and the places the buttons
 * sit in.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => shell(element).querySelector<T>(selector)!;
const wrap = (element: DatumFormBuilderElement): HTMLElement => q(element, "[data-shell=wrap]");
const group = (element: DatumFormBuilderElement): HTMLElement => q(element, "[data-mode-actions]");
const canvas = (element: DatumFormBuilderElement): ShadowRoot => q(element, "datum-builder-canvas").shadowRoot!;
const c = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => canvas(element).querySelector<T>(selector)!;

/** Pretends the shell's wrap is `width` px wide and tells the shell, as the width observer does. */
function resizeTo(element: DatumFormBuilderElement, width: number): void {
  wrap(element).getBoundingClientRect = () => ({ width, height: 800, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, toJSON: () => ({}) }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
}

/** One generated layout, so the PDF side has a layout on the page. */
function withLayout(): ReturnType<typeof sampleDefinition> {
  return {
    ...sampleDefinition(),
    pdf: {
      defaultLayoutId: "letter",
      layouts: [
        {
          id: "letter",
          kind: "generated",
          root: {
            id: "document",
            type: "pdf-document",
            configuration: {},
            children: { body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
          }
        }
      ]
    }
  } as ReturnType<typeof sampleDefinition>;
}

async function mountPdf(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = withLayout();
  document.body.append(element);
  await until(() => element.pdfMode !== undefined);
  element.mode = "pdf";
  await until(() => element.mode === "pdf" && element.pdfMode?.ready);
  return element;
}

/** The PDF mode's worded tools: Suggest mappings and Create form fields; Preview PDF is the primary action. */
const SECONDARY = "[data-suggest-mappings], [data-create-form-fields]";

/** Both worded tools start hidden (they show when a layout has something to suggest or create): show them. */
function showSecondary(element: DatumFormBuilderElement): HTMLButtonElement[] {
  const buttons = [...canvas(element).querySelectorAll<HTMLButtonElement>(SECONDARY)];
  for (const button of buttons) {
    button.hidden = false;
  }
  return buttons;
}

describe("a mode's worded actions in the canvas's toolbar", () => {
  it("puts Suggest mappings and Create form fields before the zoom, Preview PDF as the accent pill before Try it, and nothing on the top bar", async () => {
    const element = await mountPdf();
    const bar = c(element, "[data-canvas-bar]");
    const tools = [...bar.querySelectorAll<HTMLButtonElement>(SECONDARY)];
    expect(tools.length).toBe(2);
    for (const tool of tools) {
      // In the card the narrow bar folds, before the width and zoom groups.
      expect(tool.parentElement).toBe(c(element, "[data-canvas-more-pop] > [data-canvas-actions]"));
      expect(tool.classList.contains("canvas-tool")).toBe(true);
      expect(tool.classList.contains("canvas-word")).toBe(true);
    }
    const preview = c(element, "[data-preview-pdf]");
    expect(preview.parentElement).toBe(bar);
    expect(preview.classList.contains("canvas-try")).toBe(true);
    expect(preview.nextElementSibling).toBe(c(element, "[data-try-it]"));
    expect(group(element).querySelectorAll("button").length).toBe(0);
    expect(shell(element).querySelector("[data-mode-more], [data-mode-more-pop]")).toBeNull();
    expect(wrap(element).hasAttribute("data-fold-mode-actions")).toBe(false);
  });

  it("names the canvas's fold for the mode while a worded tool shows, and opens it on its first tool, putting it away when one runs", async () => {
    const element = await mountPdf();
    const more = c<HTMLButtonElement>(element, "[data-canvas-more]");
    expect(more.getAttribute("aria-label")).toBe("Width and zoom");
    const before = showSecondary(element);
    // The canvas follows the mode showing them.
    await until(() => more.getAttribute("aria-label") === "More PDF tools");
    expect(more.getAttribute("data-tip")).toBe("More PDF tools");
    const bar = c(element, "[data-canvas-bar]");
    // jsdom evaluates no container query: the button is shown as a narrow bar shows it.
    more.style.display = "inline-flex";
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(bar.hasAttribute("data-more-open")).toBe(true);
    // The bar is one Tab stop, so opening the card takes focus into it.
    expect(canvas(element).activeElement).toBe(before[0]);

    // A tool run from the card puts it away, focus back on its button.
    let fired = 0;
    before[1]!.addEventListener("click", () => (fired += 1));
    before[1]!.focus();
    before[1]!.click();
    expect(fired).toBe(1);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(canvas(element).activeElement).toBe(more);

    more.click();
    before[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(canvas(element).activeElement).toBe(more);
  });

  it("puts every action in the menu drawer on a phone, and back in the canvas's toolbar once the shell widens", async () => {
    const element = await mountPdf();
    const buttons = showSecondary(element);
    const preview = c<HTMLButtonElement>(element, "[data-preview-pdf]");
    const homeOf = (button: HTMLElement): string | null =>
      button.closest("[data-menu-host]") ? "drawer" : button.getRootNode() === canvas(element) && button.closest("[data-canvas-bar]") ? "canvas" : null;
    resizeTo(element, 390);
    expect(wrap(element).hasAttribute("data-phone")).toBe(true);
    expect([...buttons, preview].map(homeOf)).toEqual(["drawer", "drawer", "drawer"]);
    resizeTo(element, 960);
    expect([...buttons, preview].map(homeOf)).toEqual(["canvas", "canvas", "canvas"]);
    // The buttons themselves moved, never copies, and in their order.
    expect([...canvas(element).querySelectorAll(SECONDARY)].every((button, index) => button === buttons[index])).toBe(true);
    expect(preview.nextElementSibling).toBe(c(element, "[data-try-it]"));
    resizeTo(element, 1400);
    expect([...buttons, preview].map(homeOf)).toEqual(["canvas", "canvas", "canvas"]);
  });

  it("sizes the popovers to the shell's box through --db-shell-w", async () => {
    const element = await mountPdf();
    resizeTo(element, 960);
    expect(wrap(element).style.getPropertyValue("--db-shell-w")).toBe("960px");
    // The overlays sit outside .wrap and carry it themselves; the host keeps no inline style.
    expect(element.builder!.hasAttribute("style")).toBe(false);
    const dialog = q(element, "[data-preview-dialog]");
    expect(dialog.style.getPropertyValue("--db-shell-w")).toBe("960px");
  });

  it("marks the bar tight under 1100px, so the document face drops its chips", async () => {
    const element = await mountPdf();
    resizeTo(element, 1400);
    expect(wrap(element).hasAttribute("data-bar-tight")).toBe(false);
    resizeTo(element, 1099);
    expect(wrap(element).hasAttribute("data-bar-tight")).toBe(true);
    resizeTo(element, 1100);
    expect(wrap(element).hasAttribute("data-bar-tight")).toBe(false);
  });

  it("keeps focus on an action through any resize short of a phone", async () => {
    const element = await mountPdf();
    resizeTo(element, 1400);
    const preview = c<HTMLButtonElement>(element, "[data-preview-pdf]");
    preview.focus();
    resizeTo(element, 1450);
    expect(canvas(element).activeElement).toBe(preview);
    resizeTo(element, 960);
    expect(canvas(element).activeElement).toBe(preview);
  });
});

describe("the canvas's toolbar is one Tab stop", () => {
  it("roves its shown, enabled tools with the arrows, Home and End, and keeps the stop on the tool last used", async () => {
    const element = await mountPdf();
    const bar = c(element, "[data-canvas-bar]");
    expect(bar.getAttribute("role")).toBe("toolbar");
    const stops = (): HTMLElement[] => [...bar.querySelectorAll<HTMLElement>("button")].filter((button) => button.getAttribute("tabindex") === "0");
    expect(stops().length).toBe(1);
    const key = (target: HTMLElement, name: string): void => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true }));
    };
    const preview = c<HTMLButtonElement>(element, "[data-preview-pdf]");
    const tryIt = c<HTMLButtonElement>(element, "[data-try-it]");
    preview.focus();
    expect(stops()).toEqual([preview]);
    key(preview, "ArrowRight");
    expect(canvas(element).activeElement).toBe(tryIt);
    // Wraps at the end; the hidden worded tools (nothing to suggest here) are skipped.
    key(tryIt, "ArrowRight");
    const first = canvas(element).activeElement as HTMLElement;
    expect(first.matches(SECONDARY)).toBe(false);
    key(first, "End");
    expect(canvas(element).activeElement).toBe(tryIt);
    key(tryIt, "Home");
    expect(canvas(element).activeElement).toBe(first);
    expect(stops()).toEqual([first]);
  });
});

describe("the Journeys bar actions", () => {
  function journeyDefinition(): ReturnType<typeof sampleDefinition> {
    return {
      ...sampleDefinition(),
      journey: {
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
        defaultJourneyId: "intake"
      }
    } as unknown as ReturnType<typeof sampleDefinition>;
  }

  it("keeps the Map | Step group on the bar, and has no Add unassigned or Remove missing to fold", async () => {
    const element = document.createElement("datum-form-builder");
    element.setAttribute("features", "-pdf");
    element.definition = journeyDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    element.mode = "journeys";
    await until(() => element.builder!.mode === "journeys" && element.journeyMode?.ready);
    resizeTo(element, 1200);
    const views = q(element, "[data-journey-views]");
    expect(views.parentElement).toBe(group(element));
    expect(views.classList.contains("bar-seg")).toBe(true);
    // The switch is the mode's one control, navigation: none of it goes to the canvas's toolbar.
    expect(element.builder!.shadowRoot!.querySelector("[data-journey-add-unassigned]")).toBeNull();
    expect(element.builder!.shadowRoot!.querySelector("[data-journey-remove-missing]")).toBeNull();
    expect(canvas(element).querySelector("[data-canvas-actions] > *")).toBeNull();
    expect(group(element).hidden).toBe(false);
  });
});
