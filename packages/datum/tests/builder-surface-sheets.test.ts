import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The phone sheets of the Logic rule editor and the Data row editor: a dialog with a name, focus in on open and back on close, a scrim a tap closes, Escape,
 * and a grabber. jsdom has no layout, so the shell never decides "phone" here; the tests set
 * data-phone on the surface the way the shell does.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const logicEl = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector("datum-builder-logic") as HTMLElement;
const dataEl = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector("datum-builder-data") as HTMLElement;
const escape = (target: Element): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
};

async function mount(workspace: "logic" | "data", ready: string): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  element.builder!.setWorkspace(workspace);
  const host = (): HTMLElement | null => shell(element).querySelector(workspace === "logic" ? "datum-builder-logic" : "datum-builder-data");
  await until(() => host()?.shadowRoot?.querySelector(ready));
  return element;
}

describe("the Logic rule editor as a phone sheet", () => {
  const RULE = '[data-logic-rule="form:email:visibleWhen"]';

  it("is a plain editor off the phone: no dialog role, no scrim, no grabber", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    const root = logicEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>(RULE)!.click();
    const editor = root.querySelector<HTMLElement>("[data-logic-editor]")!;
    expect(editor.getAttribute("role")).toBeNull();
    expect(root.querySelector("[data-sheet-scrim]")).toBeNull();
    expect(root.querySelector("[data-sheet-grab]")).toBeNull();
  });

  it("announces as a modal dialog with a scrim and a grabber, and moves focus in", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    logicEl(element).setAttribute("data-phone", "");
    const root = logicEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>(RULE)!.focus();
    root.querySelector<HTMLButtonElement>(RULE)!.click();
    const editor = root.querySelector<HTMLElement>("[data-logic-editor]")!;
    expect(editor.getAttribute("role")).toBe("dialog");
    expect(editor.getAttribute("aria-modal")).toBe("true");
    expect(editor.getAttribute("aria-labelledby")).toBe("editor-title");
    expect(root.getElementById("editor-title")).not.toBeNull();
    expect(root.querySelector("[data-sheet-scrim]")).not.toBeNull();
    const grab = root.querySelector<HTMLButtonElement>("[data-sheet-grab]")!;
    expect(grab.getAttribute("aria-label")).toBeTruthy();
    expect(grab.getAttribute("aria-expanded")).toBe("false");
    expect(editor.contains(root.activeElement)).toBe(true);
    // The existing Close / Discard footer button stays the keyboard path.
    expect(root.querySelector("[data-logic-discard], [data-logic-close]")).not.toBeNull();
  });

  it("toggles tall on a tap of the grabber", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    logicEl(element).setAttribute("data-phone", "");
    const root = logicEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>(RULE)!.click();
    const editor = root.querySelector<HTMLElement>("[data-logic-editor]")!;
    root.querySelector<HTMLButtonElement>("[data-sheet-grab]")!.click();
    expect(editor.hasAttribute("data-tall")).toBe(true);
    expect(root.querySelector("[data-sheet-grab]")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on Escape and gives focus back to the rule", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    logicEl(element).setAttribute("data-phone", "");
    const root = logicEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>(RULE)!.click();
    escape(root.activeElement ?? root.querySelector("[data-logic-editor]")!);
    expect(root.querySelector("[data-logic-editor]")).toBeNull();
    expect(root.activeElement).toBe(root.querySelector(RULE));
  });

  it("closes when the scrim is tapped", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    logicEl(element).setAttribute("data-phone", "");
    const root = logicEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>(RULE)!.click();
    root.querySelector<HTMLElement>("[data-sheet-scrim]")!.click();
    expect(root.querySelector("[data-logic-editor]")).toBeNull();
    expect(root.querySelector("[data-sheet-scrim]")).toBeNull();
  });

  it("styles the scrim, the grabber and the 44px targets for the phone only", async () => {
    const element = await mount("logic", "[data-logic-rule]");
    const css = logicEl(element).shadowRoot!.querySelector("style")!.textContent!;
    expect(css).toContain(":host([data-phone]) .sheet-scrim");
    expect(css).toContain(":host([data-phone]) .sheet-grab-btn");
    expect(css).toMatch(/:host\(\[data-phone\]\) \.choice \{ min-block-size: 44px/);
    expect(css).not.toContain("`");
  });
});

describe("the Data row editor as a phone sheet", () => {
  it("announces as a modal dialog, takes focus, closes on Escape and returns focus to the row", async () => {
    const element = await mount("data", "[data-data-row]");
    dataEl(element).setAttribute("data-phone", "");
    const root = dataEl(element).shadowRoot!;
    const row = root.querySelector<HTMLButtonElement>("[data-data-row]")!;
    const id = row.dataset.dataRow!;
    row.focus();
    row.click();
    const editor = root.querySelector<HTMLElement>("[data-data-editor]")!;
    expect(editor.getAttribute("role")).toBe("dialog");
    expect(editor.getAttribute("aria-modal")).toBe("true");
    expect(editor.getAttribute("aria-labelledby")).toBe("data-editor-title");
    expect(root.querySelector("[data-sheet-scrim]")).not.toBeNull();
    expect(root.querySelector("[data-sheet-grab]")).not.toBeNull();
    expect(editor.contains(root.activeElement)).toBe(true);
    escape(root.activeElement!);
    expect(root.querySelector("[data-data-editor]")).toBeNull();
    expect((root.activeElement as HTMLElement | null)?.dataset.dataRow).toBe(id);
  });

  it("closes when the scrim is tapped", async () => {
    const element = await mount("data", "[data-data-row]");
    dataEl(element).setAttribute("data-phone", "");
    const root = dataEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>("[data-data-row]")!.click();
    root.querySelector<HTMLElement>("[data-sheet-scrim]")!.click();
    expect(root.querySelector("[data-data-editor]")).toBeNull();
  });

  it("is a plain editor off the phone", async () => {
    const element = await mount("data", "[data-data-row]");
    const root = dataEl(element).shadowRoot!;
    root.querySelector<HTMLButtonElement>("[data-data-row]")!.click();
    expect(root.querySelector("[data-data-editor]")!.getAttribute("role")).toBeNull();
    expect(root.querySelector("[data-sheet-scrim]")).toBeNull();
  });
});
