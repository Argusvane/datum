import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import { readPdfComponentStyle, resolvePdfTheme, type PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";

function state(values: Record<string, unknown>): FormState {
  return {
    values,
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
}

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

const form: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "T" },
  children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }, { id: "b", type: "text", configuration: { label: "B" } }] }
};

const garbage = { size: "12", spacingBefore: "6pt", width: -50, labelArrangement: "sideways", color: 42, widgetHeight: Infinity, ruledLines: 1.5 };

describe("readPdfComponentStyle", () => {
  it("keeps the well-formed fields, drops the rest and says which", () => {
    const dropped: string[] = [];
    const style = readPdfComponentStyle({ ...garbage, spacingAfter: 0, custom: "kept" }, (key) => dropped.push(key));
    expect(style).toEqual({ spacingAfter: 0, custom: "kept" });
    expect(dropped.sort()).toEqual(["color", "labelArrangement", "ruledLines", "size", "spacingBefore", "widgetHeight", "width"]);
    expect(readPdfComponentStyle({ size: 12, width: 80, labelArrangement: "inline", color: "#123456", ruledLines: 2, spacingBefore: null })).toEqual({ size: 12, width: 80, labelArrangement: "inline", color: "#123456", ruledLines: 2 });
    expect(readPdfComponentStyle("nope")).toEqual({});
  });
});

describe("component styles of the wrong kind", () => {
  const theme = (scale?: number): PdfThemeDefinition =>
    ({ id: "t", version: "1.0.0", target: "pdf", pdf: { ...(scale !== undefined ? { scale } : {}), components: { text: { style: garbage } } } }) as unknown as PdfThemeDefinition;

  it("are dropped from a theme, scaled or not, with a style.invalid warning", async () => {
    for (const scale of [undefined, 0.8]) {
      const warnings: Array<{ code: string }> = [];
      const resolved = resolvePdfTheme(theme(scale), (warning) => warnings.push(warning));
      expect(resolved.components.text?.style, String(scale)).toEqual({});
      expect(warnings.length).toBe(7);
      expect(new Set(warnings.map((warning) => warning.code))).toEqual(new Set(["style.invalid"]));
    }
  });

  it("from a theme or a binding leave the document to render, every number a number", async () => {
    const layout = {
      id: "l",
      kind: "generated" as const,
      root: {
        id: "d",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            { id: "f1", type: "pdf-field", configuration: { componentId: "a" } },
            { id: "f2", type: "pdf-field", configuration: { componentId: "b", rendition: "field", style: { widgetHeight: "big", width: Infinity, size: 11 } } }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(form, state({ a: "x", b: "y" }), resolver, {}, { theme: theme(0.8), layout });
    const drawn: PdfBlock[] = [];
    walkPdfBlocks(model.document?.blocks ?? [], (block) => {
      if (block.componentId === "a" || block.componentId === "b") {
        drawn.push(block);
      }
    });
    const a = drawn.find((block) => block.componentId === "a")!;
    const b = drawn.find((block) => block.componentId === "b") as Extract<PdfBlock, { kind: "widget" }>;
    expect(a.kind).toBe("labelValue");
    expect(a.style?.size).toBeUndefined();
    expect((a as Extract<PdfBlock, { kind: "labelValue" }>).width).toBeUndefined();
    expect(b.height).toBeUndefined();
    expect(b.width).toBeUndefined();
    expect(b.style?.size).toBe(11);
    const styleWarnings = model.warnings.filter((warning) => warning.code === "style.invalid");
    expect(styleWarnings.some((warning) => warning.componentId === "b" && /widgetHeight/.test(warning.message))).toBe(true);
    expect(styleWarnings.some((warning) => /"text"/.test(warning.message) && /size/.test(warning.message))).toBe(true);
  });
});
