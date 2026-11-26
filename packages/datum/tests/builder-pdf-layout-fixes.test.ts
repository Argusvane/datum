import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { FormDefinition, PdfConfiguration, PdfGeneratedLayout, PdfRenderProvider, PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The PDF side keeps the definition honest: a declared layout it cannot
 * use is reported and still counted by the saved baseline; opening a layout writes nothing;
 * a host's change to a layout off the page reaches the designer built over it; and a layout
 * given an id another one had is built afresh.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function generated(id: string, name: string, componentId = "fullName"): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: `${id}-field`, type: "pdf-field", configuration: { componentId } }], header: [], footer: [] }
    }
  };
}

function provider(): PdfRenderProvider {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  return {
    id: "fake",
    abiVersion: "4.0.0",
    render: async () => ({ bytes: bytes("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
    inspect: async () => ({ pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: [], hasXfa: false, encrypted: false })
  } as unknown as PdfRenderProvider;
}

function formBuilder(pdf: PdfConfiguration, listen?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.definition = { ...sampleDefinition(), pdf } as FormDefinition;
  element.pdfSupport = { provider: provider() };
  listen?.(element);
  document.body.append(element);
  return element;
}

async function onPdf(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.pdfMode !== undefined);
  element.mode = "pdf";
  await until(() => element.mode === "pdf" && element.pdfMode?.ready);
}

function boundTo(layout: PdfGeneratedLayout | undefined): string | undefined {
  return (layout?.root.children?.body?.[0]?.configuration as { componentId?: string } | undefined)?.componentId;
}

describe("the PDF side keeps the definition honest", () => {
  it("reports a declared layout it cannot use on the first seed, and the saved baseline still has it", async () => {
    const unusable = {
      id: "paper",
      kind: "template",
      name: "Paper form",
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 8, data: "JVBERi0xLjQK" },
      fields: [],
      areas: [{ id: "a1", page: 1, rect: { x: 0, y: 0, width: 0, height: 10 }, source: { kind: "literal", value: "x" } }]
    } as unknown as PdfTemplateLayout;
    const errors: string[] = [];
    const element = formBuilder({ layouts: [generated("letter", "Letter"), unusable], defaultLayoutId: "paper" }, (el) =>
      el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message))
    );
    await until(() => element.pdfMode !== undefined && element.savedDefinition !== undefined);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("1 PDF layout in the definition is unusable and was left out");
    expect(errors[0]).toContain("paper: areas[0]");
    expect(element.pdfMode!.unusableLayouts).toHaveLength(1);
    // The definition read back has lost it; the baseline has not, so the loss reads as unsaved.
    expect(element.definition.pdf!.layouts!.map((layout) => layout.id)).toEqual(["letter"]);
    expect(element.savedDefinition!.pdf!.layouts!.map((layout) => layout.id)).toEqual(["letter", "paper"]);
    expect(element.dirty).toBe(true);

    // Once the host saves, that is the baseline.
    element.markSaved();
    expect(element.dirty).toBe(false);
  });

  it("opening a named layout, and a copy of it, writes nothing: open, leave and the definition is byte for byte", async () => {
    // The default first: an edit must not reorder the block's keys either.
    const element = formBuilder({ defaultLayoutId: "a4", layouts: [generated("letter", "Letter"), generated("a4", "A4")] });
    await until(() => element.pdfMode !== undefined && element.savedDefinition !== undefined);
    const loaded = JSON.stringify(element.definition);
    const dirtyEvents: boolean[] = [];
    element.addEventListener("datum-builder-dirty-change", (event) => dirtyEvents.push((event as CustomEvent<{ dirty: boolean }>).detail.dirty));

    await onPdf(element);
    await element.pdfMode!.selectLayout("letter");
    await until(() => element.pdfMode!.layoutId === "letter" && element.pdfMode!.ready);
    // The inspector's "Layout name" box still reads the name off the tree's root.
    expect((element.pdfMode!.controller.snapshot().configuration as { name?: unknown }).name).toBe("Letter");
    element.mode = "form";
    await until(() => element.mode === "form");
    element.controller!.select("fullName");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(element.definition)).toBe(loaded);
    expect({ dirty: element.dirty, dirtyEvents }).toEqual({ dirty: false, dirtyEvents: [] });

    // A copy is an edit; opening the copy afterwards is not, and neither carries a name on its root.
    await onPdf(element);
    element.pdfMode!.duplicateLayout("letter", { select: true });
    await until(() => element.pdfMode!.layoutId === "letter-copy" && element.pdfMode!.ready);
    const afterCopy = JSON.stringify(element.definition);
    expect(Object.keys(element.definition.pdf!)).toEqual(["defaultLayoutId", "layouts"]);
    const copy = element.definition.pdf!.layouts![2] as PdfGeneratedLayout;
    expect(copy.name).toBe("Letter (copy)");
    expect(copy.root.configuration).toEqual({});
    expect((element.pdfMode!.controller.snapshot().configuration as { name?: unknown }).name).toBe("Letter (copy)");
    expect(JSON.stringify(element.definition)).toBe(afterCopy);

    // An edit on the page keeps the name at the layout's top level only.
    const tree = element.pdfMode!.controller;
    tree.setProperty("letter-field", "componentId", "country");
    const edited = element.definition.pdf!.layouts![2] as PdfGeneratedLayout;
    expect(boundTo(edited)).toBe("country");
    expect(edited.root.configuration).toEqual({});
  });

  it("a host's rename or replacement of a layout off the page reaches the designer built over it", async () => {
    const element = formBuilder({ layouts: [generated("letter", "Letter"), generated("a4", "A4")] });
    await onPdf(element);
    const mode = element.pdfMode!;
    await mode.selectLayout("a4");
    await until(() => mode.layoutId === "a4" && mode.ready);
    const a4 = mode.controller;
    await mode.selectLayout("letter");
    await until(() => mode.layoutId === "letter" && mode.ready);

    // Renamed off the page: the open tree takes the name, and an edit there keeps it.
    mode.renameLayout("a4", "A4 renamed");
    expect((a4.snapshot().configuration as { name?: unknown }).name).toBe("A4 renamed");
    await mode.selectLayout("a4");
    await until(() => mode.layoutId === "a4" && mode.ready);
    expect(mode.controller).toBe(a4);
    a4.setProperty("a4-field", "componentId", "country");
    expect(mode.layouts[1]!.name).toBe("A4 renamed");

    // Replaced off the page: rebuilt from the catalog on its next visit, and an edit keeps the replacement.
    await mode.selectLayout("letter");
    await until(() => mode.layoutId === "letter" && mode.ready);
    mode.replaceLayout("a4", generated("a4", "A4 replaced", "subscribe"));
    await mode.selectLayout("a4");
    await until(() => mode.layoutId === "a4" && mode.ready);
    expect((mode.controller.snapshot().children!.body![0]!.configuration as { componentId: string }).componentId).toBe("subscribe");
    mode.controller.setProperty(mode.controller.rootId(), "title", "Hello");
    const kept = mode.layouts[1] as PdfGeneratedLayout;
    expect(boundTo(kept)).toBe("subscribe");
    expect(kept.name).toBe("A4 replaced");
  });

  it("a layout given the id another one had before is built afresh", async () => {
    const element = formBuilder({ layouts: [generated("letter", "Letter"), generated("a4", "A4")] });
    await onPdf(element);
    const mode = element.pdfMode!;
    await until(() => mode.layoutId === "letter" && mode.ready);
    const before = mode.controller;
    mode.replaceLayout("letter", { ...mode.layouts[0]!, id: "letter-old" } as PdfGeneratedLayout);
    await until(() => mode.layoutId === "letter-old" && mode.ready);

    mode.addLayout(generated("letter", "Fresh", "country"), { select: true });
    await until(() => mode.layoutId === "letter" && mode.ready);
    expect(mode.controller).not.toBe(before);
    const tree = mode.controller.snapshot();
    expect((tree.children!.body![0]!.configuration as { componentId: string }).componentId).toBe("country");
    expect((tree.configuration as { name?: unknown }).name).toBe("Fresh");
    // An edit there writes the new layout, not the one that had the id.
    mode.controller.setProperty(mode.controller.rootId(), "title", "Hello");
    const fresh = mode.layouts.find((layout) => layout.id === "letter") as PdfGeneratedLayout;
    expect(fresh.name).toBe("Fresh");
    expect(boundTo(fresh)).toBe("country");
    expect(boundTo(mode.layouts.find((layout) => layout.id === "letter-old") as PdfGeneratedLayout)).toBe("fullName");
  });
});
