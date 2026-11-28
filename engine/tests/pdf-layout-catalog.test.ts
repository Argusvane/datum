import { describe, expect, it } from "vitest";

import {
  addPdfLayout,
  duplicatePdfLayout,
  effectivePdfDefaultLayoutId,
  movePdfLayout,
  newGeneratedPdfLayout,
  pdfLayoutIdFromName,
  pdfLayoutLabel,
  removePdfLayout,
  replacePdfLayout,
  setDefaultPdfLayout,
  uniquePdfLayoutId
} from "../form-engine/builder/pdf-designer/layout-catalog.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  findPdfLayout,
  validatePdfLayout,
  type PdfConfiguration,
  type PdfGeneratedLayout,
  type PdfTemplateLayout
} from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";

function generated(id: string, name?: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    ...(name !== undefined ? { name } : {}),
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } }
  };
}

const PAPER: PdfTemplateLayout = {
  id: "paper",
  kind: "template",
  name: "Paper form",
  template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 10, ref: "/paper.pdf" },
  fields: [{ pdfField: "Name", source: { kind: "component", componentId: "fullName" } }]
};

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Customer Intake" },
  children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
};

function configuration(): PdfConfiguration {
  return { layouts: [generated("client", "Client copy"), PAPER], defaultLayoutId: "client" };
}

describe("layout ids and labels", () => {
  it("slugs a typed name into an id and keeps ids unique with a numeric suffix", () => {
    expect(pdfLayoutIdFromName("Client copy")).toBe("client-copy");
    expect(pdfLayoutIdFromName("  Bureau — Réception #2 ")).toBe("bureau-reception-2");
    expect(pdfLayoutIdFromName("!!!")).toBe("layout");
    expect(uniquePdfLayoutId("client", ["paper"])).toBe("client");
    expect(uniquePdfLayoutId("client", ["client", "client-2"])).toBe("client-3");
  });

  it("labels a layout by its name for the locale, falling back to the id", () => {
    expect(pdfLayoutLabel(PAPER, "en")).toBe("Paper form");
    expect(pdfLayoutLabel(generated("back-office"), "en")).toBe("back-office");
    // The name is a string in the default language; a translation sits at `pdf › paper › name`.
    const translations = { fr: { pdf: { paper: { name: { text: "Formulaire papier", source: sourceHash("Paper form") } } } } };
    expect(pdfLayoutLabel(PAPER, "fr-CA", { translations })).toBe("Formulaire papier");
    expect(pdfLayoutLabel(PAPER, "en", { translations })).toBe("Paper form");
    // The host's catalog wins over the map, as it does at render time.
    expect(pdfLayoutLabel(PAPER, "fr-CA", { translations, catalog: { "fr-CA": { pdf: { paper: { name: "Papier" } } } } })).toBe("Papier");
    // An empty name is no name: the id stands.
    expect(pdfLayoutLabel({ ...PAPER, name: "" }, "en")).toBe("paper");
  });

  it("names the effective default: the declared one when it exists, else the first", () => {
    expect(effectivePdfDefaultLayoutId(configuration())).toBe("client");
    expect(effectivePdfDefaultLayoutId({ ...configuration(), defaultLayoutId: "gone" })).toBe("client");
    expect(effectivePdfDefaultLayoutId({ layouts: [PAPER] })).toBe("paper");
    expect(effectivePdfDefaultLayoutId(undefined)).toBeUndefined();
  });
});

describe("editing the catalog", () => {
  it("adds a layout under a free id and refuses a taken or empty one", () => {
    const before = configuration();
    const next = addPdfLayout(before, generated("back-office", "Back office"));
    expect(next.layouts?.map((layout) => layout.id)).toEqual(["client", "paper", "back-office"]);
    expect(next.defaultLayoutId).toBe("client");
    // The given configuration is untouched.
    expect(before.layouts?.length).toBe(2);
    expect(() => addPdfLayout(before, generated("paper"))).toThrow(/already exists/);
    expect(() => addPdfLayout(before, generated("  "))).toThrow(/needs an id/);
    // Starting from nothing works too.
    expect(addPdfLayout(undefined, generated("only")).layouts?.map((layout) => layout.id)).toEqual(["only"]);
  });

  it("replaces a layout in place, and a rename carries the default along", () => {
    const renamed = replacePdfLayout(configuration(), "client", generated("client-facing", "Client-facing"));
    expect(renamed.layouts?.map((layout) => layout.id)).toEqual(["client-facing", "paper"]);
    expect(renamed.defaultLayoutId).toBe("client-facing");
    // Renaming onto another layout's id is refused; replacing under the same id is not a collision.
    expect(() => replacePdfLayout(configuration(), "client", generated("paper"))).toThrow(/already exists/);
    expect(replacePdfLayout(configuration(), "paper", { ...PAPER, fields: [] }).layouts?.[1]).toMatchObject({ id: "paper", fields: [] });
    expect(() => replacePdfLayout(configuration(), "missing", generated("x"))).toThrow(/No PDF layout/);
  });

  it("removes a layout, moving the default to the first survivor when it was the one removed", () => {
    const withoutDefault = removePdfLayout(configuration(), "client");
    expect(withoutDefault.layouts?.map((layout) => layout.id)).toEqual(["paper"]);
    expect(withoutDefault.defaultLayoutId).toBe("paper");
    const withoutOther = removePdfLayout(configuration(), "paper");
    expect(withoutOther.defaultLayoutId).toBe("client");
    expect(removePdfLayout({ layouts: [PAPER], defaultLayoutId: "paper" }, "paper")).toEqual({ layouts: [] });
    expect(() => removePdfLayout(configuration(), "missing")).toThrow(/No PDF layout/);
  });

  it("sets the default only to a layout it has", () => {
    expect(setDefaultPdfLayout(configuration(), "paper").defaultLayoutId).toBe("paper");
    expect(() => setDefaultPdfLayout(configuration(), "missing")).toThrow(/No PDF layout/);
    expect(findPdfLayout({ pdf: setDefaultPdfLayout(configuration(), "paper") })?.id).toBe("paper");
  });

  it("duplicates a layout as a deep copy under a fresh id and a '(copy)' name", () => {
    const { configuration: next, layout } = duplicatePdfLayout(configuration(), "paper");
    expect(layout.id).toBe("paper-copy");
    expect(layout.name).toBe("Paper form (copy)");
    expect(layout).not.toBe(PAPER);
    expect((layout as PdfTemplateLayout).fields).toEqual(PAPER.fields);
    expect((layout as PdfTemplateLayout).fields).not.toBe(PAPER.fields);
    expect(next.layouts?.map((entry) => entry.id)).toEqual(["client", "paper", "paper-copy"]);
    // A second copy takes the next free id; a chosen id and name are used as given.
    expect(duplicatePdfLayout(next, "paper").layout.id).toBe("paper-copy-2");
    const chosen = duplicatePdfLayout(configuration(), "client", { id: "internal", name: "Internal" }).layout;
    expect(chosen).toMatchObject({ id: "internal", name: "Internal", kind: "generated" });
    expect(() => duplicatePdfLayout(configuration(), "client", { id: "paper" })).toThrow(/already exists/);
  });
});

describe("conditional layouts keep a declared default", () => {
  const QUEBEC = 'province = "QC"';
  const conditional = (id: string): PdfGeneratedLayout => ({ ...generated(id), when: QUEBEC });
  const undeclared = (): PdfConfiguration => ({ layouts: [generated("client", "Client copy"), PAPER] });

  it("keeps the Default pill on the declared default, else the first, whatever the conditions", () => {
    expect(effectivePdfDefaultLayoutId({ layouts: [conditional("quebec"), generated("standard")] })).toBe("quebec");
    expect(effectivePdfDefaultLayoutId({ layouts: [conditional("quebec"), generated("standard")], defaultLayoutId: "standard" })).toBe("standard");
  });

  it("moves a layout to a new place, writing the default down first so what prints when none holds stays", () => {
    const moved = movePdfLayout({ ...undeclared(), extra: "kept" } as PdfConfiguration, "paper", 0);
    expect(moved.layouts?.map((layout) => layout.id)).toEqual(["paper", "client"]);
    // The first layout was the default for want of a declared one: it stays the default, now by name.
    expect(moved.defaultLayoutId).toBe("client");
    expect((moved as unknown as Record<string, unknown>).extra).toBe("kept");
    expect(findPdfLayout({ pdf: moved })?.id).toBe("client");
    // A declared default stays as it was; a place past either end is clamped.
    const three: PdfConfiguration = { layouts: [generated("a"), generated("b"), generated("c")], defaultLayoutId: "b" };
    expect(movePdfLayout(three, "a", 99)).toEqual({ layouts: [generated("b"), generated("c"), generated("a")], defaultLayoutId: "b" });
    expect(movePdfLayout(three, "c", -4).layouts?.map((layout) => layout.id)).toEqual(["c", "a", "b"]);
    expect(movePdfLayout(three, "b", 1.7).layouts?.map((layout) => layout.id)).toEqual(["a", "b", "c"]);
    expect(() => movePdfLayout(three, "missing", 0)).toThrow(/No PDF layout/);
    expect(() => movePdfLayout(three, "a", Number.NaN)).toThrow(/must be a number/);
    // The configuration given is untouched.
    expect(three.layouts?.map((layout) => layout.id)).toEqual(["a", "b", "c"]);
  });

  it("declares the default once a layout gains a when — saved on it, added, or copied — and not before", () => {
    // Saved on a layout (the Rules tab's path goes through replace): the default the form had is written.
    const saved = replacePdfLayout(undeclared(), "paper", { ...PAPER, when: QUEBEC });
    expect(saved.defaultLayoutId).toBe("client");
    expect(replacePdfLayout(undeclared(), "client", { ...conditional("client"), name: "Client copy" }).defaultLayoutId).toBe("client");
    // Added.
    expect(addPdfLayout(undeclared(), conditional("quebec")).defaultLayoutId).toBe("client");
    expect(addPdfLayout(undefined, conditional("quebec")).defaultLayoutId).toBe("quebec");
    // Copied: the copy keeps its original's condition.
    const withCondition = replacePdfLayout({ layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, "client", conditional("client"));
    const copied = duplicatePdfLayout({ layouts: withCondition.layouts! }, "client");
    expect(copied.layout.when).toEqual(QUEBEC);
    expect(copied.configuration.defaultLayoutId).toBe("client");
    // Without a condition anywhere nothing is written: a definition is not rewritten for nothing.
    expect(addPdfLayout(undeclared(), generated("back-office")).defaultLayoutId).toBeUndefined();
    expect(replacePdfLayout(undeclared(), "paper", { ...PAPER, fields: [] }).defaultLayoutId).toBeUndefined();
    expect(duplicatePdfLayout(undeclared(), "paper").configuration.defaultLayoutId).toBeUndefined();
    // The builder handing back a layout it opened, with a condition already on it, is no edit: nothing is declared.
    expect(replacePdfLayout(undeclared(), "paper", { ...PAPER, when: QUEBEC }, { declareDefault: false })).not.toHaveProperty("defaultLayoutId");
  });

  it("keeps the default declared when a layout is removed", () => {
    const pdf: PdfConfiguration = { layouts: [generated("standard"), conditional("quebec"), PAPER] };
    // The implicit default goes: the first survivor is written down, conditional or not.
    expect(removePdfLayout(pdf, "standard")).toMatchObject({ defaultLayoutId: "quebec" });
    // Another layout goes: the implicit default is written down as it stood.
    expect(removePdfLayout(pdf, "paper")).toMatchObject({ defaultLayoutId: "standard" });
    // The declared default goes: the first survivor, as ever.
    expect(removePdfLayout({ ...pdf, defaultLayoutId: "paper" }, "paper").defaultLayoutId).toBe("standard");
    // The last condition goes: nothing new is written.
    expect(removePdfLayout({ layouts: [generated("standard"), conditional("quebec")] }, "quebec").defaultLayoutId).toBeUndefined();
  });
});

describe("new generated layouts", () => {
  it("derives one from the form, or starts blank, under the caller's id and name", () => {
    const derived = newGeneratedPdfLayout({ id: "client-copy", name: "Client copy", formRoot: FORM, from: "form" });
    expect(derived).toMatchObject({ id: "client-copy", kind: "generated", name: "Client copy" });
    expect(JSON.stringify(derived.root)).toContain('"componentId":"fullName"');
    expect(validatePdfLayout(derived)).toEqual([]);

    const blank = newGeneratedPdfLayout({ id: "blank", formRoot: FORM, from: "blank" });
    expect(blank.name).toBeUndefined();
    expect(blank.root.type).toBe(PDF_DOCUMENT_COMPONENT_TYPE);
    expect(blank.root.children).toEqual({ body: [], header: [], footer: [] });
    expect(validatePdfLayout(blank)).toEqual([]);
    expect(() => newGeneratedPdfLayout({ id: "", formRoot: FORM, from: "blank" })).toThrow(/needs an id/);
  });
});
