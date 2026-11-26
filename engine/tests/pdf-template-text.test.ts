import { describe, expect, it } from "vitest";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";

import {
  evaluateTemplateExpression,
  hasTemplatePlaceholders,
  renderTemplateText,
  templateSegmentsToRuns
} from "../form-engine/render/pdf/template-text.js";

const values = { firstName: "Ada", lastName: "Lovelace", age: 36, tags: ["x", "y"], nothing: null };

describe("renderTemplateText", () => {
  it("substitutes form-scoped placeholders and keeps the text between them", () => {
    const rendered = renderTemplateText("Dear {{firstName}} {{ lastName }}, aged {{age}}: {{tags}}.", { values });
    expect(rendered.text).toBe("Dear Ada Lovelace, aged 36: x, y.");
    expect(rendered.segments).toEqual([{ kind: "text", text: "Dear Ada Lovelace, aged 36: x, y." }]);
    expect(rendered.unresolved).toEqual([]);
  });

  it("reads row, ancestor and host scopes, and formats through the caller's formatter", () => {
    const rendered = renderTemplateText("{{rowNumber}}. {{row.sku}} for {{ancestor.order.customer}} via {{host.channel}} — {{country}}", {
      values: { country: "CA" },
      rowValues: { sku: "A-1" },
      ancestorValues: { order: { customer: "Ada" } },
      hostContext: { channel: "web", rowNumber: 3 },
      formatPath: (path, raw) => (path === "country" && raw === "CA" ? "Canada" : undefined)
    });
    expect(rendered.text).toBe("3. A-1 for Ada via web — Canada");
  });

  it("keeps page tokens as tokens and reports unresolved placeholders", () => {
    const rendered = renderTemplateText("Page {{page}} of {{pages}} — {{missing}}!", { values });
    expect(rendered.segments).toEqual([
      { kind: "text", text: "Page " },
      { kind: "token", token: "pageNumber" },
      { kind: "text", text: " of " },
      { kind: "token", token: "pageCount" },
      { kind: "text", text: " — !" }
    ]);
    expect(rendered.text).toBe("Page {{page}} of {{pages}} — !");
    expect(rendered.unresolved).toEqual(["missing"]);
    expect(templateSegmentsToRuns(rendered.segments)).toEqual([
      { text: "Page " },
      { text: "#", token: "pageNumber" },
      { text: " of " },
      { text: "#", token: "pageCount" },
      { text: " — !" }
    ]);
  });

  it("leaves text with no placeholders alone", () => {
    expect(hasTemplatePlaceholders("plain")).toBe(false);
    expect(hasTemplatePlaceholders("{{x}}")).toBe(true);
    expect(renderTemplateText("plain {notquite}", { values })).toEqual({
      segments: [{ kind: "text", text: "plain {notquite}" }],
      text: "plain {notquite}",
      unresolved: []
    });
    expect(renderTemplateText("", { values }).segments).toEqual([]);
  });
});

describe("evaluateTemplateExpression", () => {
  it("evaluates an expression AST to text, and an impossible one to nothing", () => {
    expect(
      evaluateTemplateExpression(
        { kind: "call", name: "concat", args: [{ kind: "path", path: "firstName" }, { kind: "literal", value: " " }, { kind: "path", path: "lastName" }] },
        { values }
      )
    ).toBe("Ada Lovelace");
    expect(evaluateTemplateExpression({ kind: "arithmetic", operator: "add", left: { kind: "path", path: "age" }, right: { kind: "literal", value: 1 } }, { values })).toBe("37");
    expect(evaluateTemplateExpression({ kind: "path", path: "nothing" }, { values })).toBe("");
  });

  it("prints the branch an if chooses, and nothing when no case matches and there is no else", () => {
    const adult = { kind: "binary" as const, operator: "gte" as const, left: { kind: "path" as const, path: "age" }, right: { kind: "literal" as const, value: 18 } };
    const choose = (elseText?: string) => ({
      kind: "if" as const,
      cases: [{ when: adult, then: { kind: "literal" as const, value: "Adult" } }],
      ...(elseText !== undefined ? { else: { kind: "literal" as const, value: elseText } } : {})
    });
    expect(evaluateTemplateExpression(choose("Minor"), { values })).toBe("Adult");
    expect(evaluateTemplateExpression(choose("Minor"), { values: { age: 12 } })).toBe("Minor");
    expect(evaluateTemplateExpression(choose(), { values: { age: 12 } })).toBe("");
    // The day beside the host context: today() reads it, and two valid days order by code unit.
    const signedThisYear = { kind: "binary" as const, operator: "gte" as const, left: { kind: "call" as const, name: "today" as const, args: [] }, right: { kind: "literal" as const, value: "2026-01-01" } };
    expect(evaluateTemplateExpression(signedThisYear, { values, today: "2026-10-07", hostContext: { channel: "web" } })).toBe("true");
    expect(evaluateTemplateExpression({ kind: "call", name: "today", args: [] }, { values })).toBe("");
  });
});

describe("template mappings from a repeating section", () => {
  const root = {
    id: "f",
    type: "form",
    configuration: { title: "F" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        {
          id: "items",
          type: "panel",
          configuration: { label: "Items" },
          collection: { collectionPath: "items", itemFields: ["sku"] },
          children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
        }
      ]
    }
  } as unknown as ComponentNode;
  const state = (v: Record<string, unknown>): FormState =>
    ({
      values: v,
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true },
      submission: { status: "idle", attempts: 0 },
      navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
      locale: "en"
    }) as unknown as FormState;
  const tpl = { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" };

  it("maps one path source per cell, and warns mapping.collection for a collection or a component inside one", async () => {
    const layout = {
      id: "t",
      kind: "template",
      template: tpl,
      fields: [
        { pdfField: "r0", source: { kind: "path", path: "items[0].sku" } },
        { pdfField: "all", source: { kind: "component", componentId: "items" } },
        { pdfField: "row", source: { kind: "component", componentId: "sku" } },
        { pdfField: "who", source: { kind: "component", componentId: "name" } }
      ]
    } as never;
    const model = (await buildPdfRenderModel(root, state({ "items[0].sku": "A", name: "Ada" }), { resolveDataSource: async () => undefined } as never, {}, { layout })) as never as {
      fill: { values: Record<string, unknown> };
      warnings: { code: string; message: string; componentId?: string }[];
    };
    expect(model.fill.values).toMatchObject({ r0: "A", who: "Ada" });
    expect(model.fill.values.all ?? null).toBeNull();
    expect(model.fill.values.row ?? null).toBeNull();
    const warned = model.warnings.filter((warning) => warning.code === "mapping.collection");
    expect(warned.map((warning) => warning.componentId)).toEqual(["items", "sku"]);
    expect(warned[0]!.message).toContain('Field "all"');
    expect(warned[1]!.message).toContain('Field "row"');
  });
});

describe("template mappings from a data grid", () => {
  const root = {
    id: "f",
    type: "form",
    configuration: { title: "F" },
    children: {
      content: [
        {
          id: "lines",
          type: "dataGrid",
          configuration: { label: "Lines" },
          collection: { collectionPath: "items" },
          children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
        }
      ]
    }
  } as unknown as ComponentNode;
  const state = (v: Record<string, unknown>): FormState =>
    ({
      values: v,
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true },
      submission: { status: "idle", attempts: 0 },
      navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
      locale: "en"
    }) as unknown as FormState;
  const tpl = { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" };

  it("maps a row's cell by path source, and warns mapping.collection naming the grid, for the grid and for a cell", async () => {
    const layout = {
      id: "t",
      kind: "template",
      template: tpl,
      fields: [
        { pdfField: "r1", source: { kind: "path", path: "items[1].sku" } },
        { pdfField: "all", source: { kind: "component", componentId: "lines" } },
        { pdfField: "cell", source: { kind: "component", componentId: "sku" } }
      ]
    } as never;
    const model = (await buildPdfRenderModel(root, state({ "items[0].sku": "A", "items[1].sku": "B" }), { resolveDataSource: async () => undefined } as never, {}, { layout })) as never as {
      fill: { values: Record<string, unknown> };
      warnings: { code: string; message: string; componentId?: string }[];
    };
    expect(model.fill.values.r1).toBe("B");
    expect(model.fill.values.all ?? null).toBeNull();
    expect(model.fill.values.cell ?? null).toBeNull();
    const warned = model.warnings.filter((warning) => warning.code === "mapping.collection");
    expect(warned.map((warning) => warning.componentId)).toEqual(["lines", "sku"]);
    expect(warned[0]!.message).toContain("the data grid");
    expect(warned[1]!.message).toContain('Map each row cell with a path source such as "items[0].sku"');
  });
});
