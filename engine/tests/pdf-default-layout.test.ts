import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { validatePdfLayout } from "../form-engine/core/schema/pdf-layout.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { deriveDefaultPdfLayout } from "../form-engine/render/pdf/default-layout.js";

function form(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        {
          id: "steps",
          type: "tabs",
          configuration: { tabs: [{ id: "a", label: "Step A" }, { id: "b", label: "Step B" }] },
          children: {
            a: [{ id: "name", type: "text", configuration: { label: "Name" } }],
            b: [
              {
                id: "grid",
                type: "grid",
                configuration: { columns: "8/4" },
                children: {
                  column_1: [{ id: "city", type: "text", configuration: {} }],
                  column_2: [{ id: "zip", type: "text", configuration: {} }, { id: "go", type: "button", configuration: {} }]
                }
              }
            ]
          }
        },
        {
          id: "unlabelled",
          type: "container",
          configuration: {},
          children: { content: [{ id: "email", type: "text", configuration: {} }] }
        },
        {
          id: "rows",
          type: "panel",
          configuration: { label: "Rows" },
          collection: {},
          children: { content: [{ id: "sku", type: "text", configuration: {} }] }
        },
        { id: "html", type: "html", configuration: { content: "<p>Hi</p>" } },
        { id: "submit", type: "button", configuration: {} }
      ]
    }
  };
}

describe("deriveDefaultPdfLayout", () => {
  it("builds a valid generated layout that reinterprets the tree for paper", () => {
    const layout = deriveDefaultPdfLayout(form());
    expect(validatePdfLayout(layout)).toEqual([]);
    expect(layout.id).toBe("default");
    expect(layout.name).toBe("Intake");
    expect(layout.page).toEqual({ footer: { height: 24 } });

    const body = layout.root.children!.body!;
    expect(body.map((node) => [node.type, node.id])).toEqual([
      ["pdf-text", "title"],
      ["pdf-section", "sec-steps-a"],
      ["pdf-section", "sec-steps-b"],
      ["pdf-field", "pdf-email"],
      ["pdf-field", "pdf-rows"],
      ["pdf-field", "pdf-html"]
    ]);
    expect(body[0]!.configuration).toEqual({ text: "Intake", variant: "h1" });
    expect(body[1]!.configuration).toEqual({ label: "Step A", skipWhenEmpty: true });
    expect(body[1]!.children!.content).toEqual([{ id: "pdf-name", type: "pdf-field", configuration: { componentId: "name" } }]);

    const table = body[2]!.children!.content![0]!;
    expect(table).toMatchObject({ type: "pdf-table", configuration: { rows: 1, columns: 2, header: false, borders: "none" } });
    expect(table.children!.r1c1).toEqual([{ id: "pdf-city", type: "pdf-field", configuration: { componentId: "city" } }]);
    // The button in the second column is gone.
    expect(table.children!.r1c2).toEqual([{ id: "pdf-zip", type: "pdf-field", configuration: { componentId: "zip" } }]);

    // The running footer is the title block's other half: the title at the start, the count at the end.
    const footer = layout.root.children!.footer![0]!;
    expect(footer).toMatchObject({ type: "pdf-table", configuration: { rows: 1, columns: 2, borders: "none" } });
    expect(footer.children!.r1c1![0]).toMatchObject({ type: "pdf-text", configuration: { variant: "muted" } });
    expect(footer.children!.r1c2![0]).toMatchObject({ type: "pdf-text", configuration: { text: "Page {{page}} of {{pages}}", align: "end" } });
  });

  it("words the form's own texts for the language asked for, from the places the form keeps them", () => {
    const translations = {
      fr: {
        form: { title: { text: "Admission", source: sourceHash("Intake") } },
        components: {
          steps: { tabs: { a: { label: { text: "Étape A", source: sourceHash("Step A") } } } },
          rows: { label: { text: "Lignes", source: sourceHash("Rows") } }
        }
      }
    };
    const layout = deriveDefaultPdfLayout(form(), { locale: "fr-CA", translations });
    const body = layout.root.children!.body!;
    // The title is the form's, translated at `form › title`; `fr` serves `fr-CA`.
    expect(layout.name).toBe("Admission");
    expect(body[0]!.configuration).toMatchObject({ text: "Admission" });
    // A tab's caption is the container's, by the tab's id; the other tab has no translation and keeps its string.
    expect(body.slice(1, 3).map((node) => (node.configuration as { label: string }).label)).toEqual(["Étape A", "Step B"]);
    // No locale asked for: the strings as authored.
    expect(deriveDefaultPdfLayout(form(), { translations }).name).toBe("Intake");
  });

  it("words the footer's page count from the theme's own wording, host data a layout's text cannot be", () => {
    const pageOf = { default: "Page {{page}} of {{pages}}", locales: { fr: "Page {{page}} sur {{pages}}" } };
    const footerText = (locale?: string): unknown => {
      const layout = deriveDefaultPdfLayout(form(), { pageOf, ...(locale ? { locale } : {}) });
      return (layout.root.children!.footer![0]!.children!.r1c2![0]!.configuration as { text: unknown }).text;
    };
    expect(footerText("fr")).toBe("Page {{page}} sur {{pages}}");
    expect(footerText()).toBe("Page {{page}} of {{pages}}");
  });

  it("marks every section and grid table it makes skip-when-empty, so a container a rule hides leaves no orphan heading", () => {
    const layout = deriveDefaultPdfLayout(form());
    const containers: ComponentNode[] = [];
    const walk = (node: ComponentNode): void => {
      if (node.type === "pdf-section" || node.type === "pdf-table") {
        containers.push(node);
      }
      for (const children of Object.values(node.children ?? {})) {
        children.forEach(walk);
      }
    };
    // The body's containers; the running footer's own table always prints.
    layout.root.children!.body!.forEach(walk);
    expect(containers.map((node) => node.id)).toEqual(["sec-steps-a", "sec-steps-b", "tbl-grid"]);
    expect(containers.every((node) => (node.configuration as { skipWhenEmpty?: boolean }).skipWhenEmpty === true)).toBe(true);
  });

  it("is deterministic and keeps ids unique when the form repeats a name", () => {
    const first = deriveDefaultPdfLayout(form());
    expect(deriveDefaultPdfLayout(form())).toEqual(first);
    const clash: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "title", type: "text", configuration: { label: "Title" } }] }
    };
    const layout = deriveDefaultPdfLayout(clash, { title: "T", id: "mine", noFooter: true });
    expect(layout.id).toBe("mine");
    expect(layout.root.children!.body!.map((node) => node.id)).toEqual(["title", "pdf-title"]);
    expect(layout.root.children!.footer).toEqual([]);
    expect(layout.page).toEqual({});
  });
});

describe("deriveDefaultPdfLayout — a data grid", () => {
  const grid = (): ComponentNode => ({
    id: "lines",
    type: "dataGrid",
    configuration: { label: "Lines", layout: "stacked" },
    collection: { collectionPath: "items" },
    children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }, { id: "remove", type: "button", configuration: {} }] }
  });
  const around = (child: ComponentNode): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: {},
    children: { content: [{ id: "who", type: "text", configuration: {} }, child] }
  });

  it("binds the grid as one field, without its row template: the rendition draws the rows", () => {
    const layout = deriveDefaultPdfLayout(around(grid()), { noFooter: true });
    expect(validatePdfLayout(layout)).toEqual([]);
    expect(layout.root.children!.body!.map((node) => [node.type, node.id, node.children])).toEqual([
      ["pdf-field", "pdf-who", undefined],
      ["pdf-field", "pdf-lines", undefined]
    ]);
    expect(layout.root.children!.body![1]!.configuration).toEqual({ componentId: "lines" });
  });

  it("binds a grid inside a heading container the way it binds a section, and an empty grid too", () => {
    const inside: ComponentNode = {
      id: "wrap",
      type: "fieldset",
      configuration: { label: "Order" },
      children: { content: [grid(), { id: "none", type: "dataGrid", configuration: {}, collection: { collectionPath: "none" } }] }
    };
    const layout = deriveDefaultPdfLayout(around(inside), { noFooter: true });
    const section = layout.root.children!.body![1]!;
    expect(section.type).toBe("pdf-section");
    expect(section.children!.content!.map((node) => [node.type, (node.configuration as { componentId?: string }).componentId])).toEqual([
      ["pdf-field", "lines"],
      ["pdf-field", "none"]
    ]);
  });
});
