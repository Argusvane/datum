import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * "Open in Languages" through `<datum-form-builder>`: the pointer line
 * under a component's texts (and under a Header & footer part) opens the Languages workspace
 * filtered to it, also when the leave guard holds the switch behind its prompt (the author has
 * an unapplied draft) and answers it. The surface and the model are held to account in the
 * engine's suites; this is the shell's half.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const surface = (element: DatumFormBuilderElement): ShadowRoot | null => shell(element).querySelector("datum-builder-languages")?.shadowRoot ?? null;

/** The inspector's pointer button for the selected component, once drawn. */
async function pointer(element: DatumFormBuilderElement, componentId: string): Promise<HTMLButtonElement> {
  element.controller!.select(componentId);
  const props = (): ShadowRoot | null => shell(element).querySelector("datum-builder-properties")?.shadowRoot ?? null;
  await until(() => props()?.querySelector("[data-open-in-languages]"));
  return props()!.querySelector<HTMLButtonElement>("[data-open-in-languages]")!;
}

const rowKeys = (root: ParentNode): string[] => [...root.querySelectorAll("[data-languages-row]")].map((row) => row.getAttribute("data-languages-row")!);

function expectFilteredTo(root: ShadowRoot, prefix: string): void {
  const keys = rowKeys(root);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((key) => key.startsWith(prefix))).toBe(true);
  expect(root.querySelector<HTMLSelectElement>("[data-languages-status]")!.value).toBe("all");
  expect(root.querySelector<HTMLInputElement>("[data-languages-search]")!.value).toBe("");
  expect(root.querySelector('[data-languages-group][aria-pressed="true"]')?.getAttribute("data-languages-group")).toBe("all");
}

describe("Open in Languages from the inspector", () => {
  it("opens the Texts filtered to the selected component, the other filters cleared", async () => {
    const element = await mount();
    (await pointer(element, "fullName")).click();
    await until(() => surface(element)?.querySelector("[data-languages-row]"));
    expect(element.builder!.workspace).toBe("languages");
    expectFilteredTo(surface(element)!, "components/fullName/");
  });

  it("keeps the component when the leave guard holds the switch behind an unapplied draft, and delivers it once the author saves", async () => {
    const element = await mount();
    await pointer(element, "fullName");
    const controller = element.controller!;
    controller.setDraftProperty("fullName", "placeholder", "Your name");
    // The draft repaints the panel: the button is the one drawn after it.
    (await pointer(element, "fullName")).click();
    // The switch waits on the prompt: Languages is not on the page yet, the draft is held.
    expect(element.builder!.workspace).not.toBe("languages");
    expect(controller.unsavedChangesPrompt()).toMatchObject({ componentId: "fullName", action: "leave" });

    controller.answerUnsavedChangesPrompt("save");
    await until(() => surface(element)?.querySelector("[data-languages-row]"));
    expect(element.builder!.workspace).toBe("languages");
    // The saved placeholder is a text of the component now; the rows are its own and nobody else's.
    expectFilteredTo(surface(element)!, "components/fullName/");
    expect(rowKeys(surface(element)!)).toContain("components/fullName/placeholder");
  });

  it("drops the component when the author stays, so a later switch to Languages is unfiltered", async () => {
    const element = await mount();
    await pointer(element, "fullName");
    const controller = element.controller!;
    controller.setDraftProperty("fullName", "placeholder", "Your name");
    // The draft repaints the panel: the button is the one drawn after it.
    (await pointer(element, "fullName")).click();
    controller.answerUnsavedChangesPrompt("stay");
    expect(element.builder!.workspace).not.toBe("languages");

    controller.discardDraft("fullName");
    element.builder!.setWorkspace("languages");
    await until(() => surface(element)?.querySelector("[data-languages-row]"));
    expect(surface(element)!.querySelector("[data-languages-component]")).toBeNull();
    expect(rowKeys(surface(element)!)).toContain("components/country/label");
  });
});

describe("Open in Languages from the Header & footer panel", () => {
  it("opens the Texts filtered to the part whose line was clicked", async () => {
    const element = document.createElement("datum-form-builder");
    const definition = sampleDefinition();
    definition.root.configuration = {
      ...(definition.root.configuration as Record<string, unknown>),
      chrome: { header: [{ id: "title", type: "form-title" }, { id: "welcome", type: "text", text: "Welcome" }] }
    };
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="chrome"]')!.click();
    const panel = (): ShadowRoot | null => shell(element).querySelector("datum-builder-chrome-panel")?.shadowRoot ?? null;
    await until(() => panel()?.querySelector('[data-chrome-part-id="welcome"] [data-open-in-languages]'));
    // The form-title part has no text of its own: it draws no line.
    expect(panel()!.querySelector('[data-chrome-part-id="title"] [data-translation-pointer]')).toBeNull();
    panel()!.querySelector<HTMLButtonElement>('[data-chrome-part-id="welcome"] [data-open-in-languages]')!.click();
    await until(() => surface(element)?.querySelector("[data-languages-row]"));
    expect(element.builder!.workspace).toBe("languages");
    expect(rowKeys(surface(element)!)).toEqual(["chrome/welcome/text"]);
  });
});

describe("the exchange dialog when the shell hides Languages", () => {
  it("closes an Export dialog a workspace change from code leaves behind", async () => {
    const element = await mount();
    element.builder!.setWorkspace("languages");
    await until(() => surface(element)?.querySelector("[data-languages-export]"));
    surface(element)!.querySelector<HTMLButtonElement>("[data-languages-export]")!.click();
    expect(surface(element)!.querySelector("[data-languages-exchange-dialog]")).toBeTruthy();

    element.builder!.setWorkspace("form");
    expect(surface(element)!.querySelector("[data-languages-exchange-dialog]")).toBeNull();
  });
});
