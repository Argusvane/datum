import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The inspector's ID and Saved as rows explain themselves with a "?", as a described property
 * does: hovering reads the note, a click shows it in place, and it stays open while the author
 * edits and moves between components. The ID's note says the id is unique across the form and
 * how it relates to where the answer is stored; the Saved as note says what that path is.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

/** The sample form with a container that nests its data, holding one field. */
function withMailingAddress(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.splice(3, 0, {
    id: "mailingAddress",
    type: "container",
    configuration: { label: "Mailing address", scopeData: true },
    children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] }
  });
  return definition;
}

async function mount(definition: FormDefinition): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspectorElement = (element: DatumFormBuilderElement) =>
  shell(element).querySelector<HTMLElement & { primary: boolean }>("datum-builder-properties")!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => inspectorElement(element).shadowRoot!;

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

const note = (element: DatumFormBuilderElement, id: string): HTMLElement => inspector(element).querySelector<HTMLElement>(`#${id}`)!;

describe("ID and Saved as help", () => {
  it("opens the ID's note in place from its ?, and keeps it open through a repaint and a new selection", async () => {
    const element = await mount(sampleDefinition());
    await select(element, "email");
    const toggle = inspector(element).querySelector<HTMLButtonElement>('[data-help-toggle="id"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Help: ID");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Hovering reads it: the same text is the button's title.
    expect(toggle.title).toContain("This component's name across the whole form.");
    expect(toggle.title).toContain("no two components can share one, even inside different containers");
    expect(toggle.title).toContain("If so, the Saved as line shows where.");
    expect(note(element, "prop-id-help").hidden).toBe(true);
    // The box reads the note as its description.
    expect(inspector(element).querySelector('input[data-prop="id"]')!.getAttribute("aria-describedby")).toBe("prop-id-help");

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(note(element, "prop-id-help").hidden).toBe(false);
    expect(note(element, "prop-id-help").textContent).toBe(toggle.title);

    // A repaint (the id typed now clashes) keeps it open, the problem under it.
    type(inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')!, "country");
    await until(() => inspector(element).querySelector("#problem-id"));
    expect(note(element, "prop-id-help").hidden).toBe(false);
    expect(inspector(element).querySelector('[data-help-toggle="id"]')!.getAttribute("aria-expanded")).toBe("true");

    // So does moving on to another component, as a property's note does.
    element.builder!.controller.discardDraft("email");
    await select(element, "fullName");
    expect(note(element, "prop-id-help").hidden).toBe(false);

    // And the ? closes it again.
    inspector(element).querySelector<HTMLButtonElement>('[data-help-toggle="id"]')!.click();
    expect(note(element, "prop-id-help").hidden).toBe(true);
  });

  it("gives the Saves to line of a field in a nesting container its own ?, and the filter finds both rows by name", async () => {
    const element = await mount(withMailingAddress());
    await select(element, "city");
    const row = inspector(element).querySelector<HTMLElement>("[data-saved-as]")!;
    expect(row.querySelector<HTMLInputElement>("input")!.value).toBe("mailingAddress.city");
    const toggle = row.querySelector<HTMLButtonElement>('[data-help-toggle="savedAs"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Help: Saves to");
    toggle.click();
    expect(note(element, "prop-savedAs-help").hidden).toBe(false);
    expect(note(element, "prop-savedAs-help").textContent).toBe(
      "Where this answer is stored in the submitted data. The path joins the keys of the containers above it that nest data, then its own Data key, or its ID when it has none. Submissions, exports and the Data workspace all use this path."
    );
    // The ID's note says the answer is not simply under the id here.
    expect(note(element, "prop-id-help").textContent).toContain("unless it has a Data key or sits inside a container that nests data");

    const filter = inspector(element).querySelector<HTMLInputElement>("[data-property-filter]")!;
    type(filter, "saves");
    expect(inspector(element).querySelector<HTMLElement>("[data-saved-as]")!.hidden).toBe(false);
    expect(inspector(element).querySelector('input[data-prop="id"]')!.closest<HTMLElement>(".property-row")!.hidden).toBe(true);
    type(filter, "id");
    expect(inspector(element).querySelector('input[data-prop="id"]')!.closest<HTMLElement>(".property-row")!.hidden).toBe(false);
  });

  it("says what the container stores under its id, and draws the Saves to line even where the path is the id", async () => {
    const element = await mount(withMailingAddress());
    await select(element, "mailingAddress");
    expect(inspector(element).querySelector<HTMLInputElement>("[data-saved-as] input")!.value).toBe("mailingAddress");
    expect(note(element, "prop-id-help").textContent).toContain("The answers inside it are nested under the ID too");
    await select(element, "submit");
    expect(note(element, "prop-id-help").textContent).toMatch(/It stores no answer of its own\.$/);
  });

  it("on another mode's tree, such as a PDF layout, says a layout stores no answers and draws no Saved as line", async () => {
    const element = await mount(withMailingAddress());
    await select(element, "city");
    expect(inspector(element).querySelector("[data-saved-as]")).not.toBeNull();
    inspectorElement(element).primary = false;
    await until(() => !inspector(element).querySelector("[data-saved-as]"));
    expect(note(element, "prop-id-help").textContent).toContain("A layout stores no answers of its own: it shows the form's.");
    inspectorElement(element).primary = true;
    await until(() => inspector(element).querySelector("[data-saved-as]"));
  });

  it("explains the form root's read-only ID in the Form panel", async () => {
    const element = await mount(sampleDefinition());
    shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="form"]')!.click();
    const form = (): ShadowRoot => shell(element).querySelector("datum-builder-form-panel")!.shadowRoot!;
    await until(() => form().querySelector('[data-help-toggle="id"]'));
    const toggle = form().querySelector<HTMLButtonElement>('[data-help-toggle="id"]')!;
    expect(toggle.title).toBe(
      "The form's own ID. No component in the form can take it. The form's answers are stored at the top level of the submitted data, not under it."
    );
    toggle.click();
    expect(form().querySelector<HTMLElement>("#prop-id-help")!.hidden).toBe(false);
    expect(form().querySelector('input[data-prop="id"]')).toBeNull();
  });
});
