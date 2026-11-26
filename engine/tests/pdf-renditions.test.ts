import { describe, expect, it } from "vitest";

import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { PdfRenditionRegistry } from "../form-engine/registry/pdf/pdf-rendition-registry.js";
import {
  createPdfRenditionResolver,
  resolveRenditionId
} from "../form-engine/render/pdf/pdf-renditions.js";
import {
  BUILT_IN_PDF_RENDITIONS,
  COLLECTION_PDF_RENDITIONS,
  GENERIC_CONTAINER_PDF_RENDITIONS,
  GENERIC_LEAF_PDF_RENDITIONS
} from "../form-engine/render/pdf/standard-renditions.js";
import {
  PDF_COLLECTION_RENDITIONS,
  PDF_GENERIC_CONTAINER_RENDITIONS,
  PDF_GENERIC_LEAF_RENDITIONS,
  PDF_RENDITION_CATALOG,
  PDF_RENDITION_LABELS,
  dataGridDefaultRendition,
  pdfRenditionCatalogFor
} from "../form-engine/core/schema/pdf-renditions.js";

describe("the rendition catalog", () => {
  it("names exactly the renditions the render layer implements, type by type, defaults included", () => {
    const ids = (definition: { defaultRendition: string; renditions: { id: string }[] }) => ({
      defaultRendition: definition.defaultRendition,
      ids: definition.renditions.map((rendition) => rendition.id)
    });
    expect(Object.keys(PDF_RENDITION_CATALOG).sort()).toEqual(Object.keys(BUILT_IN_PDF_RENDITIONS).sort());
    for (const [type, entry] of Object.entries(PDF_RENDITION_CATALOG)) {
      expect(ids(entry), type).toEqual(ids(BUILT_IN_PDF_RENDITIONS[type]!));
    }
    expect(ids(PDF_COLLECTION_RENDITIONS)).toEqual(ids(COLLECTION_PDF_RENDITIONS));
    expect(ids(PDF_GENERIC_LEAF_RENDITIONS)).toEqual(ids(GENERIC_LEAF_PDF_RENDITIONS));
    expect(ids(PDF_GENERIC_CONTAINER_RENDITIONS)).toEqual(ids(GENERIC_CONTAINER_PDF_RENDITIONS));
    // Every id has one label, and the labels differ.
    expect(new Set(PDF_RENDITION_LABELS.map((entry) => entry.label)).size).toBe(PDF_RENDITION_LABELS.length);
    expect(pdfRenditionCatalogFor("nope", { hasChildren: true }).defaultRendition).toBe("group");
    expect(pdfRenditionCatalogFor("text", { collection: true }).defaultRendition).toBe("table");
  });
});

describe("a data grid in the catalog", () => {
  const grid = (configuration: Record<string, unknown> = {}) => ({ id: "g", type: "dataGrid", configuration, collection: { collectionPath: "g" } });

  it("offers the collection renditions, the table first, in the catalog and in the built-in table alike", () => {
    expect(PDF_RENDITION_CATALOG.dataGrid).toBe(PDF_COLLECTION_RENDITIONS);
    expect(PDF_RENDITION_CATALOG.dataGrid!.renditions.map((rendition) => rendition.id)).toEqual(["table", "sections"]);
    expect(BUILT_IN_PDF_RENDITIONS.dataGrid!.renditions.map((rendition) => rendition.id)).toEqual(["table", "sections"]);
    expect(pdfRenditionCatalogFor("dataGrid", { hasChildren: true, collection: true })).toBe(PDF_COLLECTION_RENDITIONS);
    const resolver = createPdfRenditionResolver();
    expect(resolver.catalog("dataGrid").map((declaration) => declaration.id)).toEqual(["table", "sections"]);
    expect(resolver.defaultRenditionId("dataGrid")).toBe("table");
  });

  it("defaults to the table, and to sections only under layout: stacked", () => {
    expect(dataGridDefaultRendition(grid())).toBe("table");
    expect(dataGridDefaultRendition(grid({ layout: "auto" }))).toBe("table");
    expect(dataGridDefaultRendition(grid({ layout: "table" }))).toBe("table");
    expect(dataGridDefaultRendition(grid({ layout: "stacked" }))).toBe("sections");
    // A word the settings do not know reads as the default layout.
    expect(dataGridDefaultRendition(grid({ layout: "carousel" }))).toBe("table");
    // Another collection-bound container keeps the collection set's own default whatever its configuration says.
    expect(dataGridDefaultRendition({ id: "s", type: "panel", configuration: { layout: "stacked" }, collection: {} })).toBe("table");
  });
});

describe("createPdfRenditionResolver", () => {
  it("lists a type's renditions: definition, then plugins, then built-ins, ids unique", () => {
    const components = new ComponentRegistry();
    components.register({
      type: "text",
      version: "1.0.0",
      createDefault: () => ({ id: "t", type: "text", configuration: {} }),
      capabilities: [],
      pdf: { defaultRendition: "fancy", renditions: [{ id: "fancy", render: () => [] }, { id: "text", render: () => [] }] }
    });
    const plugins = new PdfRenditionRegistry();
    plugins.register({ componentType: "text", rendition: { id: "plugin", render: () => [] } });
    plugins.register({ componentType: "text", rendition: { id: "field", render: () => [] } });

    const resolver = createPdfRenditionResolver({ components, renditions: plugins });
    expect(resolver.catalog("text").map((r) => r.id)).toEqual(["fancy", "text", "plugin", "field", "ruled"]);
    // The definition's "text" wins over the built-in "text"; the plugin's "field" over the built-in.
    expect(resolver.resolve("text", "field")).toBe(plugins.resolve("text", "field"));
    expect(resolver.defaultRenditionId("text")).toBe("fancy");
  });

  it("answers the built-in table for a definition with no renditions, and nothing for an unknown type", () => {
    const components = new ComponentRegistry();
    components.register({
      type: "rating",
      version: "1.0.0",
      createDefault: () => ({ id: "r", type: "rating", configuration: {} }),
      capabilities: []
    });
    const resolver = createPdfRenditionResolver({ components });
    expect(resolver.defaultRenditionId("rating")).toBeUndefined();
    expect(resolver.catalog("rating")).toEqual([]);
    expect(resolver.defaultRenditionId("checkbox")).toBe(BUILT_IN_PDF_RENDITIONS.checkbox!.defaultRendition);
    expect(resolver.catalog("nothing")).toEqual([]);
    expect(resolver.defaultRenditionId("nothing")).toBeUndefined();
  });

  it("makes the first plugin contribution the default of a type nothing else knows", () => {
    const plugins = new PdfRenditionRegistry();
    plugins.register({ componentType: "rating", rendition: { id: "stars", render: () => [] } });
    plugins.register({ componentType: "rating", rendition: { id: "number", render: () => [] } });
    plugins.register({ componentType: "text", rendition: { id: "shout", render: () => [] } });
    const resolver = createPdfRenditionResolver({ renditions: plugins });
    expect(resolver.defaultRenditionId("rating")).toBe("stars");
    // A built-in type keeps its own default; the contribution is only one more choice.
    expect(resolver.defaultRenditionId("text")).toBe("text");
    expect(resolveRenditionId({ type: "rating" }, resolver)).toBe("stars");
  });
});

describe("resolveRenditionId", () => {
  const resolver = createPdfRenditionResolver();

  it("walks the ladder in order", () => {
    expect(resolveRenditionId({ type: "text", binding: "field", instance: "ruled" }, resolver)).toBe("field");
    expect(resolveRenditionId({ type: "text", instance: "ruled", layoutDefaults: { text: "field" } }, resolver)).toBe("ruled");
    expect(resolveRenditionId({ type: "text", layoutDefaults: { text: "field", "*": "ruled" } }, resolver)).toBe("field");
    expect(resolveRenditionId({ type: "text", layoutDefaults: { "*": "ruled" }, theme: "field" }, resolver)).toBe("ruled");
    expect(resolveRenditionId({ type: "text", theme: "field", themeWildcard: "ruled" }, resolver)).toBe("field");
    expect(resolveRenditionId({ type: "text", themeWildcard: "ruled" }, resolver)).toBe("ruled");
    expect(resolveRenditionId({ type: "text" }, resolver)).toBe("text");
  });

  it("warns for a named candidate the type lacks, stays quiet for a wildcard, and falls through", () => {
    const warnings: string[] = [];
    const warn = (code: string): number => warnings.push(code);
    expect(resolveRenditionId({ type: "tabs", binding: "field", layoutDefaults: { "*": "field" }, themeWildcard: "field" }, resolver, warn)).toBe("sections");
    expect(warnings).toEqual(["rendition.unknown"]);
    expect(resolveRenditionId({ type: "nothing", layoutDefaults: { "*": "field" } }, resolver, warn)).toBeUndefined();
    expect(warnings).toEqual(["rendition.unknown"]);
  });
});

describe("PdfRenditionRegistry", () => {
  it("rejects duplicates and malformed contributions", () => {
    const registry = new PdfRenditionRegistry();
    registry.register({ componentType: "text", rendition: { id: "x", render: () => [] } });
    expect(() => registry.register({ componentType: "text", rendition: { id: "x", render: () => [] } })).toThrow(/already registered/);
    expect(() => registry.register({ componentType: "", rendition: { id: "x", render: () => [] } })).toThrow(/componentType/);
    expect(() => registry.register({ componentType: "text", rendition: { id: "", render: () => [] } })).toThrow(/needs an id/);
    expect(() => registry.register({ componentType: "text", rendition: { id: "y", render: undefined as never } })).toThrow(/render function/);
    expect(registry.types()).toEqual(["text"]);
    expect(registry.list("text").map((r) => r.id)).toEqual(["x"]);
    expect(registry.list("other")).toEqual([]);
  });
});
