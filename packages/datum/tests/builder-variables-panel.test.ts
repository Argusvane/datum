import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import { clearPanelMemory, readPanelMemory } from "@argusvane/datum-engine";
import type { FormDefinition, PdfGeneratedLayout } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  clearPanelMemory("vars-t");
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

/**
 * The sample form with the shapes the panel tells apart: a field inside a data-scoping
 * container, and a repeating section with a field of its own.
 */
function withScopes(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.push(
    {
      id: "address",
      type: "container",
      configuration: { label: "Address" },
      children: { content: [{ id: "postcode", type: "text", configuration: { label: "Postcode" } }] }
    },
    {
      id: "items",
      type: "panel",
      configuration: { label: "Items" },
      collection: { collectionPath: "items", itemFields: ["qty"] },
      children: { content: [{ id: "qty", type: "number", configuration: { label: "Qty" } }] }
    }
  );
  return definition;
}

function designedLayout(): PdfGeneratedLayout {
  return {
    id: "letter",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
    }
  };
}

async function mount(definition: FormDefinition = withScopes(), setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

type VariablesPanel = HTMLElement & { syntax: "rules" | "placeholders" | undefined };

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const stripItem = (element: DatumFormBuilderElement, panel: string): HTMLButtonElement =>
  shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;
const panel = (element: DatumFormBuilderElement): VariablesPanel => shell(element).querySelector("datum-builder-variables-panel") as VariablesPanel;
const panelRoot = (element: DatumFormBuilderElement): ShadowRoot => panel(element).shadowRoot!;
const refs = (element: DatumFormBuilderElement): string[] =>
  [...panelRoot(element).querySelectorAll<HTMLElement>("[data-variable]")].map((row) => row.dataset.variable!);
const shownRefs = (element: DatumFormBuilderElement): string[] =>
  [...panelRoot(element).querySelectorAll<HTMLLIElement>(".variables-rows li")]
    .filter((row) => !row.hidden && !row.closest<HTMLElement>("[data-variables-group]")!.hidden)
    .map((row) => row.querySelector<HTMLElement>("[data-variable]")!.dataset.variable!);
const syntaxShown = (element: DatumFormBuilderElement): string | undefined =>
  panelRoot(element).querySelector<HTMLElement>("[data-variables-syntax]")?.dataset.variablesSyntax;

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Variables panel", () => {
  it("is a strip item after Outline on the form and on a PDF layout alike, listing the form's references in the syntax the tab reads", async () => {
    const element = await mount({ ...withScopes(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } });
    await until(() => element.pdfMode !== undefined);
    const item = stripItem(element, "variables");
    expect(item.getAttribute("aria-label")).toBe("Variables");
    expect(item.previousElementSibling).toBe(stripItem(element, "outline"));
    expect(item.querySelector("svg")).toBeTruthy();
    expect(panel(element).hidden).toBe(true);

    item.click();
    expect(element.builder!.panel).toBe("variables");
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(panel(element).hidden).toBe(false);
    // The panel's body is a chunk of its own, fetched on this first open.
    await until(() => panelRoot(element)?.querySelector(".variables-head"));
    expect(panelRoot(element).querySelector(".variables-head")?.textContent).toBe("Variables");

    // The form's tab: the Rules tab's paths — a field is its id wherever it sits, a repeating
    // section's fields are reached through an entry, a button is no answer, and the scopes
    // and functions a rule may use follow.
    expect(syntaxShown(element)).toBe("rules");
    const onForm = refs(element);
    expect(onForm).toContain("fullName");
    expect(onForm).toContain("postcode");
    expect(onForm).toContain("row.qty");
    expect(onForm).toContain("component");
    expect(onForm).toContain("host.key");
    expect(onForm.some((ref) => ref.startsWith("sum("))).toBe(true);
    expect(onForm).not.toContain("submit");
    expect(onForm.some((ref) => ref.startsWith("{{"))).toBe(false);

    // A PDF layout's tab: the same fields as the placeholders its text reads, by value path,
    // with the row aliases, the page tokens and the host — and the item stays, since a
    // layout's text is where they are written.
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    expect(stripItem(element, "variables").hidden).toBe(false);
    expect(element.builder!.panel).toBe("variables");
    await until(() => syntaxShown(element) === "placeholders");
    const onLayout = refs(element);
    expect(onLayout).toContain("{{fullName}}");
    expect(onLayout).toContain("{{address.postcode}}");
    expect(onLayout).toContain("{{row.qty}}");
    expect(onLayout).toContain("{{rowNumber}}");
    expect(onLayout).toContain("{{page}}");
    expect(onLayout).toContain("{{pages}}");
    expect(onLayout).toContain("{{host.key}}");
    expect(onLayout).not.toContain("fullName");
    expect(onLayout.some((ref) => ref.startsWith("sum("))).toBe(false);

    element.mode = "form";
    await until(() => element.mode === "form");
    await until(() => syntaxShown(element) === "rules");
    expect(refs(element)).toContain("fullName");
  });

  it("copies a reference on click, says so, and tells the host — with or without a clipboard", async () => {
    const element = await mount();
    stripItem(element, "variables").click();
    const picks: Array<{ reference: string; syntax: string; copied: boolean }> = [];
    element.addEventListener("builder-variable-pick", (event) => picks.push((event as CustomEvent).detail));

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const row = panelRoot(element).querySelector<HTMLButtonElement>('[data-variable="fullName"]')!;
    row.click();
    expect(writeText).toHaveBeenCalledWith("fullName");
    expect(row.hasAttribute("data-copied")).toBe(true);
    expect(panelRoot(element).querySelector("[data-variables-status]")?.textContent).toBe("Copied fullName");
    expect(picks).toEqual([{ reference: "fullName", syntax: "rules", copied: true }]);

    // A page with no clipboard (an insecure origin) still gets the event, and the reference
    // is shown so it can be typed; the mark moves to the row picked.
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    const other = panelRoot(element).querySelector<HTMLButtonElement>('[data-variable="email"]')!;
    other.click();
    expect(row.hasAttribute("data-copied")).toBe(false);
    expect(other.hasAttribute("data-copied")).toBe(true);
    expect(panelRoot(element).querySelector("[data-variables-status]")?.textContent).toBe("email");
    expect(picks[1]).toEqual({ reference: "email", syntax: "rules", copied: false });
  });

  it("filters the list as the author types, keeps the box across a repaint, and repaints for a field added to the form", async () => {
    const element = await mount();
    stripItem(element, "variables").click();
    const box = (): HTMLInputElement => panelRoot(element).querySelector<HTMLInputElement>("[data-variables-filter]")!;

    type(box(), "post");
    expect(shownRefs(element)).toEqual(["postcode"]);
    // Groups with nothing left go with their rows; a title alone would read as a hole.
    expect(panelRoot(element).querySelector<HTMLElement>('[data-variables-group="scopes"]')!.hidden).toBe(true);
    expect(panelRoot(element).querySelector<HTMLElement>("[data-variables-none]")!.hidden).toBe(true);

    type(box(), "zzz");
    expect(shownRefs(element)).toEqual([]);
    expect(panelRoot(element).querySelector<HTMLElement>("[data-variables-none]")!.hidden).toBe(false);

    // A field added on the form repaints the list (the panel reads the form's controller on
    // every tab), and the filter's text survives the repaint.
    element.builder!.controller.add("text");
    const added = element.builder!.controller.selectedComponentId()!;
    expect(box().value).toBe("zzz");
    type(box(), "");
    expect(refs(element)).toContain(added);
    expect(panelRoot(element).querySelector<HTMLElement>("[data-variables-none]")!.hidden).toBe(true);
  });

  it("is remembered under persist-panels", async () => {
    const element = await mount(withScopes(), (el) => el.setAttribute("persist-panels", "vars-t"));
    stripItem(element, "variables").click();
    expect(readPanelMemory("vars-t")?.panel).toBe("variables");
  });
});

describe("the Variables panel heading", () => {
  it("titles itself with a real heading above its groups", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    stripItem(element, "variables").click();
    await until(() => panelRoot(element).querySelector(".variables-head"));
    const head = panelRoot(element).querySelector(".variables-head")!;
    expect(head.tagName).toBe("H2");
    expect(head.textContent).toBe("Variables");
  });
});
