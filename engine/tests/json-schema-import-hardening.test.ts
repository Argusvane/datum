import { describe, expect, it } from "vitest";

import { dataModelFromJsonSchema } from "../form-engine/builder/data-model/from-json-schema.js";
import { escapeHtml } from "../form-engine/render/core/escape-html.js";
import {
  journeyAddPopoverHtml,
  journeyEmptyStateHtml
} from "../form-engine/builder/journey-designer/journey-designer-panels.js";
import type { BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";

/** The names a property gets in the model's top-level object, in order. */
function topLevelNames(schema: unknown): string[] {
  const model = dataModelFromJsonSchema(schema);
  const root = model.root as { children?: Array<{ key: string }> };
  return (root.children ?? []).map((child) => child.key);
}

describe("a __proto__ property in an imported JSON Schema", () => {
  it("is kept and renamed at the top level", () => {
    const names = topLevelNames(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}}'));
    expect(names).toEqual(["__proto___key", "a"]);
  });

  it("is kept and renamed the same way under allOf", () => {
    const names = topLevelNames(
      JSON.parse('{"allOf":[{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}}]}')
    );
    expect(names).toEqual(["__proto___key", "a"]);
  });

  it("is kept when the allOf sits beside sibling properties, and touches no prototype", () => {
    const names = topLevelNames(
      JSON.parse(
        '{"type":"object","properties":{"b":{"type":"string"},"__proto__":{"type":"number"}},"allOf":[{"properties":{"a":{"type":"string"}}}]}'
      )
    );
    expect(names).toEqual(["a", "b", "__proto___key"]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });
});

describe("escapeHtml", () => {
  it("escapes the single quote, so a single-quoted attribute cannot be closed", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
    expect(escapeHtml(`<a href='x' title="y">&`)).toBe("&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;");
  });
});

describe("text from the host's catalog reaches markup escaped", () => {
  const EVIL = `<img src=x onerror=alert(1)> "q" 'a'`;
  const catalog = (keys: string[]): BuilderTextCatalog => ({
    xx: Object.fromEntries(keys.map((key) => [key, EVIL]))
  });
  const text = (keys: string[]) => ({ locale: "xx", catalog: catalog(keys) });

  it("on the journey designer's empty state", () => {
    const keys = [
      "journey.designer.empty.title",
      "journey.designer.empty.lead",
      "journey.designer.empty.form",
      "journey.designer.new.button"
    ];
    const html = journeyEmptyStateHtml({ questionCount: 1, text: text(keys) });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;a&#39;");
  });

  it("on the journey add popover", () => {
    const keys = [
      "journey.designer.add.name",
      "journey.designer.add.start",
      "journey.designer.add.empty",
      "journey.designer.add.onPageNow",
      "journey.designer.add.copy"
    ];
    const html = journeyAddPopoverHtml({ name: "n", canCopy: true, questionCount: 1, text: text(keys) });
    expect(html).not.toContain("<img");
    expect(html.split("&lt;img src=x onerror=alert(1)&gt;").length - 1).toBe(5);
  });
});
