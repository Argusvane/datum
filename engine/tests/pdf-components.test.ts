import { describe, expect, it } from "vitest";

import {
  PDF_COMPONENT_TYPES,
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  emptyPdfTableChildren,
  foldPdfTableChildren,
  pdfTableRowSlotIds,
  pdfTableSlotIds,
  readPdfBoxAnchor,
  readPdfTableSpec
} from "../form-engine/core/schema/pdf-layout.js";
import { configuredSlotIds } from "../form-engine/render/core/tab-slots.js";
import { PDF_ICC_ACCEPT, createEmptyPdfDocumentRoot, pdfComponentDefinitions, pdfComponentTypes, type PdfComponentText } from "../form-engine/render/pdf/pdf-components.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import { areaWords } from "../form-engine/builder/pdf-designer/pdf-texts-en.js";

describe("pdfComponentDefinitions", () => {
  it("declares every layout type once, registers cleanly, and creates defaults of the right type", () => {
    const definitions = pdfComponentDefinitions();
    expect(definitions.map((d) => d.type).sort()).toEqual([...PDF_COMPONENT_TYPES].sort());
    const registry = new ComponentRegistry();
    for (const definition of definitions) {
      registry.register(definition);
      const node = definition.createDefault();
      expect(node.type).toBe(definition.type);
      expect(node.id.length).toBeGreaterThan(0);
    }
    expect(registry.resolve("pdf-table").createDefault().children).toEqual({ r1c1: [], r1c2: [], r2c1: [], r2c2: [] });
  });

  it("offers every type but the root in the palette", () => {
    const types = pdfComponentTypes().map((entry) => entry.type);
    expect(types).not.toContain(PDF_DOCUMENT_COMPONENT_TYPE);
    expect(new Set(types).size).toBe(types.length);
    expect(types.length).toBe(PDF_COMPONENT_TYPES.length - 1);
    expect(createEmptyPdfDocumentRoot("doc")).toMatchObject({ id: "doc", type: PDF_DOCUMENT_COMPONENT_TYPE, children: { body: [], header: [], footer: [] } });
  });

  it("words the palette and the theme field in the builder's catalog, English where it says nothing", () => {
    const words = new BuilderWords();
    words.locale = "fr";
    words.catalog = { fr: { "pdfComponent.theme.label": "Thème PDF", "pdfComponent.palette.text": "Texte" } };
    const spoken = areaWords(words);
    const texts: PdfComponentText = (key, params) => spoken.text(key, params);
    expect(pdfComponentTypes(texts).find((entry) => entry.type === PDF_TEXT_COMPONENT_TYPE)?.label).toBe("Texte");
    expect(pdfComponentTypes(texts).find((entry) => entry.type === PDF_FIELD_COMPONENT_TYPE)?.label).toBe("Form field");
    const listed = pdfComponentDefinitions({ pdfThemes: [{ id: "datum-pdf", label: "Datum" }], texts });
    const theme = listed.find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)?.propertyEditor?.fields?.find((entry) => entry.id === "theme");
    expect(theme).toMatchObject({ label: "Thème PDF", choices: [{ value: "", label: "Host or design system default" }, { value: "datum-pdf", label: "Datum" }] });
  });

  it("words every property label, hint, choice and new-block default through the builder's catalog, English where it says nothing", () => {
    const words = new BuilderWords();
    words.locale = "fr";
    words.catalog = {
      fr: {
        "pdfComponent.doc.name": "Nom de la mise en page",
        "pdfComponent.pdfa.off": "Désactivé",
        "pdfComponent.page.landscape": "Paysage",
        "pdfComponent.text.h1": "Titre 1",
        "pdfComponent.face.repeatNone": "Répéter : aucune collection",
        "pdfComponent.face.fieldNone": "Aucun composant choisi",
        "pdfComponent.face.pageBreak": "Saut de page",
        "pdfComponent.default.section": "Rubrique",
        "pdfComponent.doc.attachName.hint": "Vide : {name}.",
        "pdfComponent.profile.builtIn": "Intégré"
      }
    };
    const spoken = areaWords(words);
    const texts: PdfComponentText = (key, params) => spoken.text(key, params);
    const definitions = pdfComponentDefinitions({ texts });
    const field = (type: string, id: string) => definitions.find((d) => d.type === type)?.propertyEditor?.fields?.find((entry) => entry.id === id);
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "name")?.label).toBe("Nom de la mise en page");
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "title")?.label).toBe("Document title");
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "pdfa")?.choices?.[0]).toEqual({ value: "", label: "Désactivé" });
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "attachment-name")?.description).toBe("Vide : submission.json.");
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "page.orientation")?.choices?.map((choice) => choice.label)).toEqual(["Portrait", "Paysage"]);
    expect(field(PDF_DOCUMENT_COMPONENT_TYPE, "output-intent-profile")?.assetChoices?.[0]?.group).toBe("Intégré");
    expect(field(PDF_TEXT_COMPONENT_TYPE, "variant")?.choices?.find((choice) => choice.value === "h1")?.label).toBe("Titre 1");
    // The blocks a new one starts as read the same words (the canvas faces' words: pdf-designer.test.ts).
    const face = (type: string) => definitions.find((d) => d.type === type);
    expect(face("pdf-section")?.createDefault().configuration).toMatchObject({ label: "Rubrique" });
    expect(face(PDF_TEXT_COMPONENT_TYPE)?.createDefault().configuration).toMatchObject({ text: "Text" });
    // No words handed in: the same English as before.
    const plain = pdfComponentDefinitions();
    expect(plain.find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)?.propertyEditor?.fields?.find((entry) => entry.id === "name")?.label).toBe("Layout name");
  });

  it("offers the document's PDF theme as a select of the host's themes, or a free id when it lists none", () => {
    const themeFieldOf = (definitions: ReturnType<typeof pdfComponentDefinitions>) =>
      definitions.find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)?.propertyEditor?.fields?.find((entry) => entry.id === "theme");

    const free = themeFieldOf(pdfComponentDefinitions());
    expect(free).toMatchObject({ type: "text", propertyPath: "theme" });

    const listed = themeFieldOf(pdfComponentDefinitions({ pdfThemes: [{ id: "datum-pdf", label: "Datum" }, { id: "gcds", label: "GC Design System" }] }));
    expect(listed).toMatchObject({ type: "select", propertyPath: "theme", label: "PDF theme", defaultValue: "" });
    expect(listed?.choices).toEqual([
      { value: "", label: "Host or design system default" },
      { value: "datum-pdf", label: "Datum" },
      { value: "gcds", label: "GC Design System" }
    ]);
    // The ladder the words describe: host default, the binding's suggestion, Datum.
    expect(listed?.description).toBe("The look this layout prints with. The default is the host's PDF theme when it sets one, then the PDF theme the form's design system suggests, then Datum.");
    expect(themeFieldOf(pdfComponentDefinitions({ pdfThemes: [] }))?.type).toBe("text");
  });

  it("offers the archival level, the output intent's profile and names, the attachment switch and its name and description on the document", () => {
    const fields = pdfComponentDefinitions().find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)?.propertyEditor?.fields ?? [];
    const byId = (id: string) => fields.find((entry) => entry.id === id);
    expect(byId("pdfa")).toMatchObject({ type: "select", propertyPath: "conformance.pdfa", label: "Archival (PDF/A)" });
    expect(byId("pdfa")?.choices?.map((choice) => choice.value)).toEqual(["", "2b", "2u", "2a", "3b", "3u", "3a"]);
    expect(byId("attach-data")).toMatchObject({ type: "boolean", propertyPath: "conformance.attachData" });
    expect(byId("attachment-name")).toMatchObject({ type: "text", propertyPath: "conformance.attachment.name" });
    expect(byId("attachment-description")).toMatchObject({ type: "localized-text", propertyPath: "conformance.attachment.description" });
    // The output intent's profile is a file the definition carries; its names are plain text.
    expect(byId("output-intent-profile")).toMatchObject({ type: "file", propertyPath: "conformance.outputIntent.profile", accept: PDF_ICC_ACCEPT });
    // Ready-made: the kernel's built-in conditions, then whatever the host offers.
    expect(byId("output-intent-profile")?.assetChoices?.map((choice) => [choice.id, choice.group])).toEqual([
      ["builtin:srgb", "Built in"],
      ["builtin:gray", "Built in"],
      ["builtin:cmyk", "Built in"]
    ]);
    const hosted = { storage: "asset", name: "FOGRA39.icc", type: "application/vnd.iccprofile", size: 1_800_000, ref: "icc/fogra39" };
    const withHost = pdfComponentDefinitions({ outputIntentProfiles: [{ id: "fogra39", label: "ISO Coated v2 (FOGRA39)", source: hosted }] })
      .find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)!
      .propertyEditor!.fields!.find((entry) => entry.id === "output-intent-profile")!;
    expect(withHost.assetChoices?.at(-1)).toEqual({ id: "host:fogra39", label: "ISO Coated v2 (FOGRA39)", group: "From the host", source: hosted });
    expect(PDF_ICC_ACCEPT.split(",")).toEqual(["application/vnd.iccprofile", ".icc", ".icm"]);
    expect(byId("output-intent-identifier")).toMatchObject({ type: "text", propertyPath: "conformance.outputIntent.identifier" });
    expect(byId("output-intent-info")).toMatchObject({ type: "text", propertyPath: "conformance.outputIntent.info" });
    expect(byId("output-intent-registry")).toMatchObject({ type: "text", propertyPath: "conformance.outputIntent.registry" });
  });

  it("offers the attachment budget and its policy on the document, and the attach switch on a field binding", () => {
    const definitions = pdfComponentDefinitions();
    const fields = definitions.find((d) => d.type === PDF_DOCUMENT_COMPONENT_TYPE)?.propertyEditor?.fields ?? [];
    const byId = (id: string) => fields.find((entry) => entry.id === id);
    expect(byId("attachments-budget")).toMatchObject({ type: "number", propertyPath: "attachments.budgetMb", min: 0 });
    expect(byId("attachments-on-exceeded")).toMatchObject({ type: "select", propertyPath: "attachments.onExceeded" });
    expect(byId("attachments-on-exceeded")?.choices?.map((choice) => choice.value)).toEqual(["", "fail"]);
    const binding = definitions.find((d) => d.type === PDF_FIELD_COMPONENT_TYPE)?.propertyEditor?.fields?.find((entry) => entry.id === "attach");
    expect(binding).toMatchObject({ type: "boolean", propertyPath: "attach", label: "Attach uploaded files" });
  });

  it("offers Skip when empty on sections, boxes and tables, as a boolean over skipWhenEmpty", () => {
    const registry = new ComponentRegistry();
    for (const definition of pdfComponentDefinitions()) {
      registry.register(definition);
    }
    for (const type of ["pdf-section", "pdf-box", "pdf-table"]) {
      const field = registry.resolve(type).propertyEditor?.fields?.find((entry) => entry.id === "skipWhenEmpty");
      expect(field, type).toMatchObject({ type: "boolean", propertyPath: "skipWhenEmpty", label: "Skip when empty" });
      expect(field?.description, type).toBeTruthy();
    }
    for (const type of ["pdf-repeat", "pdf-text"]) {
      expect(registry.resolve(type).propertyEditor?.fields?.some((entry) => entry.id === "skipWhenEmpty"), type).toBe(false);
    }
  });
});

describe("pdf-table slots", () => {
  it("derives one slot per cell from rows × columns, row-major, on both surfaces", () => {
    expect(pdfTableSlotIds({ rows: 2, columns: 3 })).toEqual(["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]);
    expect(pdfTableRowSlotIds({ rows: 2, columns: 3 }, 2)).toEqual(["r2c1", "r2c2", "r2c3"]);
    expect(configuredSlotIds({ id: "t", type: "pdf-table", configuration: { rows: "1", columns: "2" } })).toEqual(["r1c1", "r1c2"]);
    expect(Object.keys(emptyPdfTableChildren({ rows: 1, columns: 1 }))).toEqual(["r1c1"]);
  });

  it("reads the spec tolerantly", () => {
    expect(readPdfTableSpec(undefined)).toEqual({ rows: 2, columns: 2, header: true, borders: "all" });
    expect(readPdfTableSpec({ rows: 0, columns: 99, header: false, borders: "horizontal", collectionPath: " items ", widths: [1, 3] })).toEqual({
      rows: 1,
      columns: 12,
      header: false,
      borders: "horizontal",
      collectionPath: " items "
    });
    expect(readPdfTableSpec({ columns: 2, widths: [1, 3] }).widths).toEqual([1, 3]);
    expect(readPdfTableSpec({ columns: 2, widths: [1, -3] }).widths).toBeUndefined();
  });

  it("folds cells the table no longer declares into the last cell, and reports nothing to do otherwise", () => {
    const children = { r1c1: [{ id: "a", type: "pdf-text", configuration: {} }], r1c2: [], r2c1: [{ id: "b", type: "pdf-text", configuration: {} }] };
    expect(foldPdfTableChildren(children, ["r1c1", "r1c2"])).toEqual({
      r1c1: [{ id: "a", type: "pdf-text", configuration: {} }],
      r1c2: [{ id: "b", type: "pdf-text", configuration: {} }]
    });
    expect(foldPdfTableChildren(children, ["r1c1", "r1c2", "r2c1"])).toBeUndefined();
    expect(foldPdfTableChildren(undefined, ["r1c1"])).toBeUndefined();
  });
});

describe("readPdfBoxAnchor", () => {
  it("needs a usable rectangle; the page defaults to the first", () => {
    expect(readPdfBoxAnchor({})).toBeUndefined();
    expect(readPdfBoxAnchor({ anchor: { x: 1, y: 2 } })).toBeUndefined();
    expect(readPdfBoxAnchor({ anchor: { x: 1, y: 2, width: 0, height: 5 } })).toBeUndefined();
    expect(readPdfBoxAnchor({ anchor: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ page: "first", x: 1, y: 2, width: 3, height: 4 });
    expect(readPdfBoxAnchor({ anchor: { page: "every", x: 1, y: 2, width: 3, height: 4 } })?.page).toBe("every");
    expect(readPdfBoxAnchor({ anchor: { page: 2.7, x: 1, y: 2, width: 3, height: 4 } })?.page).toBe(2);
    expect(readPdfBoxAnchor({ anchor: { page: "middle", x: 1, y: 2, width: 3, height: 4 } })?.page).toBe("first");
  });
});
