import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { createPdfTemplateResolver, type PdfRenderProvider, type PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

/**
 * The Values section of a template widget in the real inspector panel: a select per
 * answer, "Same value", and "Match by order" write the widget's draft, and Save lands it as one
 * undo step. The engine suite covers the model; this covers the panel's events.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const HOSTED = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };

const provider = {
  id: "fake",
  abiVersion: "1.0.0",
  render: async () => ({ bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
  inspect: async () => ({
    pageCount: 1,
    pages: [{ index: 1, width: 612, height: 792 }],
    fields: [{ name: "Since", kind: "radio", page: 1, rect: { x: 250, y: 660, width: 14, height: 14 }, options: ["1", "2", "3"], readOnly: false, required: false }],
    hasXfa: false,
    encrypted: false
  })
} as unknown as PdfRenderProvider;

function mount(values?: Record<string, string>): DatumFormBuilderElement {
  const element = pdfAlone();
  const base = sampleDefinition();
  element.definition = {
    ...base,
    root: {
      ...base.root,
      children: {
        content: [
          ...(base.root.children?.content ?? []),
          { id: "change", type: "radio", configuration: { label: "Change", options: [{ value: "improved", label: "Improved" }, { value: "unchanged", label: "Unchanged" }, { value: "worsened", label: "Worsened" }] } }
        ]
      }
    },
    pdf: {
      layouts: [
        {
          id: "paper",
          kind: "template",
          name: "Paper form",
          template: HOSTED,
          fields: [{ pdfField: "Since", source: { kind: "component", componentId: "change" }, ...(values ? { values } : {}) }]
        } satisfies PdfTemplateLayout
      ],
      defaultLayoutId: "paper"
    }
  };
  element.pdfSupport = { provider };
  element.pdfTemplates = createPdfTemplateResolver({ url: async () => new Uint8Array([1, 2, 3]) }, { templates: [{ id: "paper-host", label: "Paper (host)", source: HOSTED }] });
  document.body.append(element);
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const properties = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const paper = (element: DatumFormBuilderElement): PdfTemplateLayout => element.pdfMode!.layouts.find((layout) => layout.id === "paper") as PdfTemplateLayout;
const rows = (element: DatumFormBuilderElement): HTMLSelectElement[] => [...properties(element).querySelectorAll<HTMLSelectElement>("[data-value-map-row]")];
const save = (element: DatumFormBuilderElement): void => properties(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function open(values?: Record<string, string>): Promise<DatumFormBuilderElement> {
  const element = mount(values);
  await until(() => element.pdfMode!.ready && element.pdfMode!.pdfLayout?.id === "paper");
  await until(() => element.pdfMode?.controller.snapshot().children?.widgets?.length === 1);
  element.pdfMode!.controller.select("widget_since");
  await until(() => properties(element).querySelector("[data-value-map]"));
  return element;
}

describe("the Values section in the inspector", () => {
  it("lists a select per answer, set to Same value, with the PDF field's options", async () => {
    const element = await open();
    const section = properties(element).querySelector<HTMLElement>('[data-inspector-section="values"]')!;
    expect(section.querySelector("summary")!.textContent).toBe("Values");
    expect(rows(element).map((select) => select.dataset.valueMapRow)).toEqual(["improved", "unchanged", "worsened"]);
    expect(rows(element).map((select) => [...select.options].map((option) => option.textContent))).toEqual([
      ["Same value", "1", "2", "3"],
      ["Same value", "1", "2", "3"],
      ["Same value", "1", "2", "3"]
    ]);
    expect(rows(element).map((select) => select.value)).toEqual(["", "", ""]);
    // Each select is named by its answer; the notice under the section is described by it.
    expect(properties(element).querySelector(`label[for="${rows(element)[0]!.id}"]`)!.textContent).toContain("Improved");
    expect(properties(element).querySelector('[data-value-map] [data-note="values"]')!.textContent).toContain("Not matched to an option");
  });

  it("writes the map on Save as one undo step, Same value removes an entry, Match by order fills every row", async () => {
    const element = await open();
    const controller = element.pdfMode!.controller;

    // A row picked is a draft: the layout waits for Save, and the repaint leaves focus on the select.
    rows(element)[0]!.focus();
    choose(rows(element)[0]!, "1");
    expect((properties(element).activeElement as HTMLElement | null)?.dataset.valueMapRow).toBe("improved");
    expect(paper(element).fields[0]).not.toHaveProperty("values");
    choose(rows(element)[2]!, "3");
    expect(rows(element).map((select) => select.value)).toEqual(["1", "", "3"]);
    save(element);
    expect(paper(element).fields[0]!.values).toEqual({ improved: "1", worsened: "3" });

    // Same value takes the entry out; the last one out leaves no values key at all.
    await until(() => rows(element).length === 3);
    choose(rows(element)[0]!, "");
    save(element);
    expect(paper(element).fields[0]!.values).toEqual({ worsened: "3" });
    await until(() => rows(element).length === 3);
    choose(rows(element)[2]!, "");
    save(element);
    expect(paper(element).fields[0]).not.toHaveProperty("values");

    // Match by order pairs the answers with the options in the one edit; undo takes it back whole.
    await until(() => properties(element).querySelector("[data-value-map-order]"));
    properties(element).querySelector<HTMLButtonElement>("[data-value-map-order]")!.click();
    expect(rows(element).map((select) => select.value)).toEqual(["1", "2", "3"]);
    save(element);
    expect(paper(element).fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    await until(() => !properties(element).querySelector('[data-value-map] [data-note="values"]'));
    controller.undo();
    expect(paper(element).fields[0]).not.toHaveProperty("values");
  });
});

describe("stale entries in the inspector", () => {
  const stale = { improved: "1", unchanged: "2", worsened: "3", other: "1", retired: "9" };
  const removeButton = (element: DatumFormBuilderElement): HTMLButtonElement | null => properties(element).querySelector<HTMLButtonElement>("[data-value-map-stale]");
  const notes = (element: DatumFormBuilderElement): string[] => [...properties(element).querySelectorAll('[data-value-map] [data-note="values"]')].map((note) => note.textContent ?? "");

  it("draws no Remove stale entries button, and no stale note, for a map that matches", async () => {
    const element = await open({ improved: "1", unchanged: "2", worsened: "3" });
    expect(removeButton(element)).toBeNull();
    expect(properties(element).querySelector("[data-value-map-order]")).not.toBeNull();
    expect(notes(element)).toEqual([]);
  });

  it("names the stale entries and removes exactly them on one press, keeping focus in the section", async () => {
    const element = await open(stale);
    const controller = element.pdfMode!.controller;
    expect(notes(element)).toEqual([
      expect.stringContaining('Entries for options this form no longer has: "other" and "retired"'),
      expect.stringContaining('"9" is not an export value of this PDF field')
    ]);
    // Beside Match by order, with the same group's aria wiring.
    const button = removeButton(element)!;
    expect(button.textContent).toBe("Remove stale entries");
    expect(button.closest("[data-value-map]")!.getAttribute("aria-describedby")).toContain("note");
    button.focus();
    button.click();
    // A draft, like Match by order: the layout waits for Save, the panel already shows the result.
    expect(paper(element).fields[0]!.values).toEqual(stale);
    await until(() => removeButton(element) === null);
    expect(notes(element)).toEqual([]);
    expect(rows(element).map((select) => select.value)).toEqual(["1", "2", "3"]);
    // The pressed button is gone: focus is in the section still, not dropped.
    expect((properties(element).activeElement as HTMLElement | null)?.closest("[data-value-map]")).not.toBeNull();
    save(element);
    expect(paper(element).fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    // One undo step puts the whole map back.
    controller.undo();
    expect(paper(element).fields[0]!.values).toEqual(stale);
  });

  it("removes the values key when every entry was stale", async () => {
    const element = await open({ gone: "1", also: "9" });
    removeButton(element)!.click();
    await until(() => removeButton(element) === null);
    save(element);
    expect(paper(element).fields[0]).not.toHaveProperty("values");
  });
});
