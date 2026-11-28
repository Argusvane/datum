// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfBuilderMode, type PdfBuilderModeOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import { readTranslation, sourceHash, type FormTranslations, type TextAddress } from "../form-engine/core/localization/translations.js";
import type { PdfConfiguration, PdfGeneratedLayout, PdfTemplateArea, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { PDF_TEMPLATE_AREAS_SLOT } from "../form-engine/render/pdf/pdf-template-components.js";

/**
 * A layout's texts are strings in the default language; their translations are the definition's
 * map under `pdf › <layoutId>`. The PDF mode reads that map to word the catalog and
 * keeps it tidy: deleting a layout, a node or a mapping prunes its addresses, a layout or node
 * under another id takes them along, a copy carries them. It rewrites the map through the form's
 * controller, which this test stands in for.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake" },
  children: { content: [{ id: "province", type: "select", configuration: { label: "Province" } }] }
};

function entry(text: string, defaultText: string): { text: string; source: string } {
  return { text, source: sourceHash(defaultText) };
}

function layout(id: string, name: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: {
        body: [
          { id: "title", type: "pdf-text", configuration: { text: "Receipt", variant: "h1" } },
          { id: "order", type: "pdf-section", configuration: { label: "Order" }, children: { content: [{ id: "note", type: "pdf-text", configuration: { text: "Thanks" } }] } }
        ],
        header: [],
        footer: []
      }
    }
  };
}

function translated(): FormTranslations {
  return {
    fr: {
      components: { province: { label: entry("Province (fr)", "Province") } },
      pdf: {
        receipt: {
          name: entry("Reçu", "Receipt layout"),
          nodes: { title: { text: entry("Reçu", "Receipt") }, order: { label: entry("Commande", "Order") }, note: { text: entry("Merci", "Thanks") } }
        },
        other: { name: entry("Autre", "Other") }
      }
    }
  };
}

/** A stand-in for the form's controller: it holds the map and applies a rewrite as one step. */
function formController(initial: FormTranslations) {
  const held = { map: initial, steps: 0 };
  return {
    held,
    form: {
      translations: () => held.map,
      rewriteTranslations: (rewrite: (map: FormTranslations) => FormTranslations) => {
        held.map = rewrite(held.map);
        held.steps += 1;
      }
    }
  };
}

function mode(pdf: PdfConfiguration, stand: ReturnType<typeof formController>, options: Partial<PdfBuilderModeOptions> = {}) {
  return createPdfBuilderMode({
    formRoot: () => FORM,
    runtime: () => ({}) as RenderableRuntime,
    pdf,
    locale: () => "fr",
    form: () => stand.form as never,
    ...options
  });
}

const read = (map: FormTranslations, address: TextAddress): string | undefined => readTranslation(map, "fr", address)?.text;
const at = (owner: string, ...path: string[]): TextAddress => ({ kind: "pdf", owner, path });

const until = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

/** Puts the mode on a page of its own (a host element each, so a shadow root is never made twice). */
async function open(m: ReturnType<typeof mode>): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  await m.activate!({ host, root: host.attachShadow({ mode: "open" }), showCanvasSurface: () => undefined } as never);
}

describe("the PDF mode and the definition's translations", () => {
  it("words a layout's name in the catalog from the map, and lists every text at its address with its default", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] }, stand);
    expect(m.documents!.list().map((document) => document.label)).toEqual(["Reçu", "Autre"]);
    const row = m.languageTexts().find((text) => text.componentId === "pdf.receipt.order" && text.propertyPath === "label")!;
    expect(row).toMatchObject({ default: "Order", address: at("receipt", "nodes", "order", "label") });
    // The option wins over the form's controller as the source of the map.
    const given = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand, { formTranslations: () => ({}) });
    expect(given.documents!.list().map((document) => document.label)).toEqual(["Receipt layout"]);
  });

  it("hands the controller the texts with their defaults, and writes a new default into the layouts", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    const document = m.localeDocument();
    expect(document.id).toBe("pdf");
    expect(document.texts()).toContainEqual({ address: at("receipt", "nodes", "note", "text"), default: "Thanks" });
    const next = document.setDefaults(document.read(), [{ address: at("receipt", "nodes", "note", "text"), default: "Merci" }]) as PdfConfiguration;
    expect(((next.layouts![0] as PdfGeneratedLayout).root.children!.body![1]!.children!.content![0]!.configuration as { text: string }).text).toBe("Merci");
    document.write(next);
    expect(m.layouts[0]).toMatchObject({ id: "receipt" });
    expect(m.languageTexts().find((text) => text.propertyPath === "text" && text.componentId === "pdf.receipt.note")!.default).toBe("Merci");
  });

  it("prunes a layout's addresses from every language when the layout is deleted, and only that layout's", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] }, stand);
    m.removeLayout("receipt");
    expect(stand.held.map.fr?.pdf?.receipt).toBeUndefined();
    expect(read(stand.held.map, at("other", "name"))).toBe("Autre");
    expect(read(stand.held.map, { kind: "components", owner: "province", path: ["label"] })).toBe("Province (fr)");
    expect(stand.held.steps).toBe(1);
  });

  it("carries a copy's translations under its own id, and leaves the original its own", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    const copy = m.duplicateLayout("receipt", { id: "receipt-2", name: "Receipt 2" });
    expect(copy.id).toBe("receipt-2");
    expect(read(stand.held.map, at("receipt-2", "nodes", "order", "label"))).toBe("Commande");
    expect(read(stand.held.map, at("receipt", "nodes", "order", "label"))).toBe("Commande");
  });

  it("moves a layout's translations when the layout is replaced under another id", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    m.replaceLayout("receipt", layout("invoice", "Receipt layout"));
    expect(stand.held.map.fr?.pdf?.receipt).toBeUndefined();
    expect(read(stand.held.map, at("invoice", "nodes", "title", "text"))).toBe("Reçu");
    // A rename of the layout's name changes the default only; its translation stays, to be flagged stale.
    m.renameLayout("invoice", "Invoice");
    expect(read(stand.held.map, at("invoice", "name"))).toBe("Reçu");
  });

  it("prunes the layouts an agent's catalog edit takes out", () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] }, stand);
    m.applyCatalogForAgent({ layouts: [layout("other", "Other")] }, "receipt");
    expect(stand.held.map.fr?.pdf?.receipt).toBeUndefined();
    expect(read(stand.held.map, at("other", "name"))).toBe("Autre");
  });

  it("prunes a node's addresses when the designer deletes it, and moves them with a new id", async () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    await open(m);
    await until(() => m.ready);

    m.controller.remove("note");
    expect(read(stand.held.map, at("receipt", "nodes", "note", "text"))).toBeUndefined();
    // Its siblings keep theirs, and so does the layout's own name.
    expect(read(stand.held.map, at("receipt", "nodes", "order", "label"))).toBe("Commande");
    expect(read(stand.held.map, at("receipt", "name"))).toBe("Reçu");

    m.controller.renameId("title", "heading");
    expect(read(stand.held.map, at("receipt", "nodes", "title", "text"))).toBeUndefined();
    expect(read(stand.held.map, at("receipt", "nodes", "heading", "text"))).toBe("Reçu");
  });

  it("moves a populated form's area text translations with the area's new id", async () => {
    const paper: PdfTemplateLayout = {
      id: "paper",
      kind: "template",
      name: "Paper",
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" },
      fields: [],
      areas: [{ id: "note", page: 1, rect: { x: 10, y: 10, width: 100, height: 20 }, kind: "text", source: { kind: "template", text: "Hello" } } as PdfTemplateArea]
    };
    const stand = formController({ fr: { pdf: { paper: { areas: { note: { text: entry("Bonjour", "Hello") } } } } } });
    const inspection: PdfTemplateInfo = { pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: [], hasXfa: false, encrypted: false };
    const m = mode({ layouts: [paper] }, stand, { support: { provider: { id: "fake", abiVersion: "4.0.0", inspect: async () => inspection } as unknown as PdfRenderProvider } });
    await open(m);
    await until(() => m.ready && m.controller.snapshot().children?.[PDF_TEMPLATE_AREAS_SLOT]?.length === 1);

    m.controller.renameId("note", "greeting");
    expect((m.layouts[0] as PdfTemplateLayout).areas?.map((area) => area.id)).toEqual(["greeting"]);
    expect(read(stand.held.map, at("paper", "areas", "note", "text"))).toBeUndefined();
    expect(read(stand.held.map, at("paper", "areas", "greeting", "text"))).toBe("Bonjour");
  });

  it("writes a node's translations again when the designer's Undo brings the node back, source-changed ones as they were", async () => {
    const map = translated();
    // The French line for the note was written against older wording: it must come back stale, not current.
    (((map.fr!.pdf!.receipt as Record<string, unknown>).nodes as Record<string, Record<string, unknown>>).note as Record<string, unknown>).text = entry("Merci", "Thanks, much");
    const stand = formController(map);
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    await open(m);
    await until(() => m.ready);

    m.controller.remove("note");
    expect(read(stand.held.map, at("receipt", "nodes", "note", "text"))).toBeUndefined();
    m.controller.undo();
    expect(readTranslation(stand.held.map, "fr", at("receipt", "nodes", "note", "text"))).toEqual(entry("Merci", "Thanks, much"));
    // Its section's own entry, pruned with the section when the section goes, comes back with it.
    m.controller.remove("order");
    expect(read(stand.held.map, at("receipt", "nodes", "order", "label"))).toBeUndefined();
    expect(read(stand.held.map, at("receipt", "nodes", "note", "text"))).toBeUndefined();
    m.controller.undo();
    expect(read(stand.held.map, at("receipt", "nodes", "order", "label"))).toBe("Commande");
    expect(read(stand.held.map, at("receipt", "nodes", "note", "text"))).toBe("Merci");
    // Redo removes them again.
    m.controller.redo();
    expect(read(stand.held.map, at("receipt", "nodes", "order", "label"))).toBeUndefined();
  });

  it("keeps an entry the author wrote in the meantime when the node comes back", async () => {
    const stand = formController(translated());
    const m = mode({ layouts: [layout("receipt", "Receipt layout")] }, stand);
    await open(m);
    await until(() => m.ready);

    m.controller.remove("note");
    stand.held.map = { fr: { ...stand.held.map.fr!, pdf: { ...stand.held.map.fr!.pdf!, receipt: { ...stand.held.map.fr!.pdf!.receipt!, nodes: { ...stand.held.map.fr!.pdf!.receipt!.nodes!, note: { text: entry("Merci beaucoup", "Thanks") } } } } } };
    m.controller.undo();
    expect(read(stand.held.map, at("receipt", "nodes", "note", "text"))).toBe("Merci beaucoup");
  });

  it("writes a layout's translations again when an agent's undo brings the layout back", () => {
    const stand = formController(translated());
    const before: PdfConfiguration = { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] };
    const m = mode(before, stand);
    m.removeLayout("receipt");
    expect(stand.held.map.fr?.pdf?.receipt).toBeUndefined();
    m.applyCatalogForAgent(before, "receipt");
    expect(m.layouts.map((entry) => entry.id)).toEqual(["receipt", "other"]);
    expect(stand.held.map).toEqual(translated());
    // The same through an agent's catalog edit taking the layout away and its undo.
    m.applyCatalogForAgent({ layouts: [layout("other", "Other")] }, "receipt");
    expect(stand.held.map.fr?.pdf?.receipt).toBeUndefined();
    m.applyCatalogForAgent(before, "receipt");
    expect(stand.held.map).toEqual(translated());
  });

  it("holds nothing across another definition", () => {
    const stand = formController(translated());
    const before: PdfConfiguration = { layouts: [layout("receipt", "Receipt layout")] };
    const m = mode(before, stand);
    m.removeLayout("receipt");
    m.reseed({ pdf: before, formRoot: () => FORM } as never);
    stand.held.map = {};
    m.applyCatalogForAgent(before, "receipt");
    expect(stand.held.map).toEqual({});
  });

  it("does nothing to the map when the form offers no way to rewrite it", () => {
    const m = createPdfBuilderMode({ formRoot: () => FORM, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout("receipt", "Receipt layout")] }, locale: () => "fr" });
    m.removeLayout("receipt");
    expect(m.layouts).toEqual([]);
  });
});

describe("a layout change and its wording are one step of the form's history", () => {
  /** The real controller of the form, holding the map; the mode rewrites it through `rewriteTranslations`. */
  function realForm(): BuilderController {
    const form = new BuilderController({ initialRoot: FORM });
    form.replaceTranslations(translated(), { silent: true });
    return form;
  }
  const realMode = (form: BuilderController, pdf: PdfConfiguration) => mode(pdf, formController({}), { form: () => form });
  const ids = (m: ReturnType<typeof mode>): string[] => m.layouts.map((entry) => entry.id);

  it("a layout removed comes back with its wording after one form Undo, and goes again on Redo", () => {
    const form = realForm();
    const start: PdfConfiguration = { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] };
    const m = realMode(form, start);
    m.removeLayout("receipt");
    expect(ids(m)).toEqual(["other"]);
    expect(form.translations()?.fr?.pdf?.receipt).toBeUndefined();
    form.undo();
    expect(ids(m)).toEqual(["receipt", "other"]);
    expect(form.translations()).toEqual(translated());
    form.redo();
    expect(ids(m)).toEqual(["other"]);
    expect(form.translations()?.fr?.pdf?.receipt).toBeUndefined();
  });

  it("a copy is taken away with its wording by one form Undo", () => {
    const form = realForm();
    const m = realMode(form, { layouts: [layout("receipt", "Receipt layout")] });
    m.duplicateLayout("receipt", { id: "receipt-2", name: "Receipt 2" });
    expect(ids(m)).toEqual(["receipt", "receipt-2"]);
    expect(form.translations()?.fr?.pdf?.["receipt-2"]).toBeDefined();
    form.undo();
    expect(ids(m)).toEqual(["receipt"]);
    expect(form.translations()).toEqual(translated());
  });

  it("a layout under another id is announced with its kind and moves back with one Undo", () => {
    const form = realForm();
    const heard: Array<{ kind: string; from: string; to: string }> = [];
    form.on("change", (event) => heard.push(...(event.renamedIds ?? [])));
    const m = realMode(form, { layouts: [layout("receipt", "Receipt layout")] });
    m.replaceLayout("receipt", layout("invoice", "Receipt layout"));
    expect(heard).toEqual([{ kind: "pdf", from: "receipt", to: "invoice" }]);
    form.undo();
    expect(ids(m)).toEqual(["receipt"]);
    expect(form.translations()).toEqual(translated());
  });

  it("a layout removed or copied on a form without translations is still one step of the form's history", () => {
    const form = new BuilderController({ initialRoot: FORM });
    const m = realMode(form, { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] });
    m.removeLayout("receipt");
    expect(form.canUndo()).toBe(true);
    form.undo();
    expect(ids(m)).toEqual(["receipt", "other"]);
    expect(form.translations()).toBeUndefined();
    form.redo();
    expect(ids(m)).toEqual(["other"]);
    form.undo();
    m.duplicateLayout("other", { id: "other-2", name: "Other 2" });
    form.undo();
    expect(ids(m)).toEqual(["receipt", "other"]);
    // Nothing more was recorded than the two actions.
    expect(form.canUndo()).toBe(false);
  });

  it("a node deleted in the designer: one form Undo brings it and its wording back, and the designer's Undo does not restore twice", async () => {
    const form = realForm();
    const m = realMode(form, { layouts: [layout("receipt", "Receipt layout")] });
    await open(m);
    await until(() => m.ready);
    const nodeIds = (): string[] => JSON.stringify((m.layouts[0] as PdfGeneratedLayout).root).match(/"id":"[a-z-]+"/g)?.map((hit) => hit.slice(6, -1)) ?? [];
    m.controller.remove("note");
    expect(nodeIds()).not.toContain("note");
    form.undo();
    expect(nodeIds()).toContain("note");
    expect(form.translations()).toEqual(translated());
    // The designer's own Undo afterwards has nothing left to restore and writes nothing twice.
    m.controller.undo();
    expect(nodeIds()).toContain("note");
    expect(form.translations()).toEqual(translated());
  });
});
