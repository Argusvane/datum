import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { runsText, walkPdfBlocks, type PdfBlock, type PdfDocument } from "../form-engine/render/pdf/pdf-document.js";

function state(values: Record<string, unknown>, locale = "en"): FormState {
  return {
    values,
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale
  };
}

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function headings(document: PdfDocument | undefined): string[] {
  const out: string[] = [];
  walkPdfBlocks(document?.blocks ?? [], (block: PdfBlock) => {
    if (block.kind === "heading") {
      out.push(runsText(block.runs));
    }
  });
  return out;
}

function people(configuration: Record<string, unknown>): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "T" },
    children: {
      content: [
        {
          id: "people",
          type: "dataGrid",
          configuration: { label: "People", layout: "stacked", ...configuration },
          collection: { collectionPath: "people" },
          children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
        }
      ]
    }
  };
}

const rows = { "people[0].name": "Ada", "people[1].name": "Grace" };

describe("a stacked data grid's row headings", () => {
  it("use the grid's rowLabel with the row's number, as on screen", async () => {
    const model = await buildPdfRenderModel(people({ rowLabel: "Person {{n}}" }), state(rows), resolver);
    expect(headings(model.document)).toEqual(expect.arrayContaining(["Person 1", "Person 2"]));
    expect(headings(model.document)).not.toContain("People 1");
  });

  it("word the rowLabel for the render's language", async () => {
    const translations: FormTranslations = { fr: { components: { people: { rowLabel: { text: "Personne {{n}}", source: sourceHash("Person {{n}}") } } } } };
    const model = await buildPdfRenderModel(people({ rowLabel: "Person {{n}}" }), state(rows, "fr"), resolver, { locale: "fr", translations });
    expect(headings(model.document)).toEqual(expect.arrayContaining(["Personne 1", "Personne 2"]));
  });

  it("fall back to the engine's row wording, not the grid's caption", async () => {
    const model = await buildPdfRenderModel(people({}), state(rows), resolver);
    expect(headings(model.document)).toEqual(expect.arrayContaining(["Row 1", "Row 2"]));
  });
});

describe("an untitled tab's caption", () => {
  it("is the lone tab component's label, else the tab's place — never its slot id", async () => {
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "T" },
      children: {
        content: [
          {
            id: "tabs",
            type: "tabs",
            configuration: { label: "Sections", tabs: [{ id: "t_one", label: "" }, { id: "t_two" }, { id: "t_three", label: "Third" }] },
            children: {
              t_one: [{ id: "a", type: "text", configuration: { label: "A" } }],
              t_two: [{ id: "tab2", type: "tab", configuration: { label: "Contact" }, children: { content: [{ id: "b", type: "text", configuration: { label: "B" } }] } }],
              t_three: [{ id: "c", type: "text", configuration: { label: "C" } }]
            }
          }
        ]
      }
    };
    const model = await buildPdfRenderModel(form, state({ a: "1", b: "2", c: "3" }), resolver);
    const captions = headings(model.document);
    expect(captions).toEqual(expect.arrayContaining(["Tab 1", "Contact", "Third"]));
    expect(captions.some((caption) => caption.startsWith("t_"))).toBe(false);
  });
});
