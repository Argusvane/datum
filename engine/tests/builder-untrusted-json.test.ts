// @vitest-environment jsdom
/**
 * Regression tests for the builder loading untrusted JSON: what a definition,
 * catalog or sample file another author shares can do to the author who opens it.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { kernelRegexRisky } from "../form-engine/core/expressions/compile.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { createTemplatePageViewer } from "../form-engine/builder/pdf-designer/template-pages.js";
import { PDF_BOX_COMPONENT_TYPE } from "../form-engine/core/schema/pdf-layout.js";
import { pdfCanvasComponents } from "../form-engine/builder/pdf-designer/pdf-canvas-adapters.js";
import type { GroupAdapter, GroupState } from "../form-engine/render/live/contract.js";
import { html, render } from "../form-engine/render/live/lit.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import { escapeHtml } from "../form-engine/render/core/escape-html.js";
import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";

const lit = (value: unknown) => ({ kind: "literal", value });
const ruled = (text: string, pattern: unknown): ComponentNode =>
  ({
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "x",
          type: "text",
          configuration: { label: "x" },
          rules: { visibleWhen: { kind: "call", name: "matches", args: [lit(text), pattern] } }
        }
      ]
    }
  }) as unknown as ComponentNode;

describe("unrolled optional atoms are a risky regex shape", () => {
  it.each([
    "a?".repeat(60) + "a".repeat(60),
    "a?".repeat(12) + "a".repeat(12),
    "[ab]?".repeat(20) + "[ab]".repeat(20),
    "(a?b?){20}c",
    "(a?|b?){30}a{30}"
  ])("flags %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(true);
  });

  it.each([
    "^\\d?\\d?\\d?-\\d{4}$",
    "^\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}$",
    "a?".repeat(11) + "a".repeat(11),
    "^[A-Z]\\d[A-Z] ?\\d[A-Z]\\d$"
  ])("passes %s", (pattern) => {
    expect(kernelRegexRisky(pattern)).toBe(false);
  });
});

describe("the builder preview refuses a risky pattern built at run time", () => {
  // Before the fix a 27-character text took about 1.3 s here and n=40 never returned.
  const slow = (build: () => unknown): number => {
    const started = performance.now();
    build();
    return performance.now() - started;
  };

  it("a pattern joined at run time does not run", () => {
    const built = { kind: "call", name: "join", args: [lit(["(a+", ")+$"]), lit("")] };
    expect(slow(() => new BuilderPreviewRuntime(ruled("a".repeat(30) + "!", built)))).toBeLessThan(500);
  });

  it("a literal pattern in a tree rule or a text rule does not run", () => {
    expect(slow(() => new BuilderPreviewRuntime(ruled("a".repeat(30) + "!", lit("(a+)+$"))))).toBeLessThan(500);
    const text = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "x",
            type: "text",
            configuration: {},
            rules: { visibleWhen: `matches("${"a".repeat(30)}!", "(a+)+$")` }
          }
        ]
      }
    } as unknown as ComponentNode;
    expect(slow(() => new BuilderPreviewRuntime(text))).toBeLessThan(500);
  });

  it("an unrolled optional pattern does not run either", () => {
    const evil = "a?".repeat(40) + "a".repeat(40);
    expect(slow(() => new BuilderPreviewRuntime(ruled("a".repeat(40), lit(evil))))).toBeLessThan(500);
  });
});

describe("the PDF box face draws a colour or nothing", () => {
  const box = pdfCanvasComponents()[PDF_BOX_COMPONENT_TYPE] as GroupAdapter;
  const draw = (configuration: Record<string, unknown>): string => {
    const node = { id: "b", type: PDF_BOX_COMPONENT_TYPE, configuration };
    const state = { id: "b", key: "b", type: PDF_BOX_COMPONENT_TYPE, base: PDF_BOX_COMPONENT_TYPE, model: { node }, slots: [] } as unknown as GroupState;
    const host = document.createElement("div");
    render(box.template(state, html``), host);
    return host.innerHTML;
  };

  it("drops a fill or border that is not a hex colour", () => {
    const html = draw({ fill: "red;background-image:url(https://evil.example/x)", borderColor: "#000;position:fixed;inset:0" });
    expect(html).not.toMatch(/url\(|position|evil/);
    expect(html).toContain("#999999");
    expect(html).not.toContain("background:");
  });
  it("keeps a hex colour", () => {
    expect(draw({ fill: "#fa0", borderColor: "#112233" })).toMatch(/background:#fa0;.*#112233|#112233.*background:#fa0/);
  });
});

describe("the PDF designer draws area rects as numbers", () => {
  it("never writes a string rect into an SVG attribute", () => {
    const viewer = createTemplatePageViewer({
      escape: escapeHtml,
      onSelect: () => undefined,
      onAreaCreate: () => undefined,
      onAreaChange: () => undefined,
      onAreaRemove: () => undefined,
      onFieldClick: () => undefined
    });
    viewer.setDocument({ pages: [{ index: 1, width: 612, height: 792 }], fields: [] } as unknown as PdfTemplateInfo, undefined);
    viewer.setAreas([{ id: "a", page: 1, rect: { x: '1" onload="alert(1)', y: 2, width: "3", height: 4 } }] as never, undefined);
    const html = viewer.element.innerHTML;
    expect(html).not.toContain("onload");
    expect(viewer.element.querySelector(".dpd-area__box")?.getAttribute("x")).toBe("0");
  });
});

describe("the preview's calculations are linear in their number", () => {
  const flat = (n: number, label = "x"): ComponentNode =>
    ({
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: Array.from({ length: n }, (_, i) => ({
          id: "c" + i,
          type: "number",
          configuration: { label: i === 0 ? label : "l" },
          // A chain: each reads the one before, so every write is read by the next calculation.
          rules: { value: i === 0 ? "1 + 1" : `c${i - 1} + 1` }
        }))
      }
    }) as unknown as ComponentNode;

  it("builds 3,000 chained calculations, and takes an edit, in well under the seconds it took", () => {
    new BuilderPreviewRuntime(flat(200));
    let started = performance.now();
    const runtime = new BuilderPreviewRuntime(flat(3000));
    const build = performance.now() - started;
    started = performance.now();
    runtime.setFormRoot(flat(3000, "y"));
    const edit = performance.now() - started;
    // Before the fix: 1,500 fields 1.4 s, 3,000 fields 5.1 s (a rebuild of the whole context after every write).
    expect(build).toBeLessThan(1500);
    expect(edit).toBeLessThan(1500);
  }, 30000);

  it("still reads each calculation's source from the one before", () => {
    const runtime = new BuilderPreviewRuntime(flat(5));
    expect((runtime as unknown as { store: { snapshot(): { values: Record<string, unknown> } } }).store.snapshot().values).toMatchObject({ c0: 2, c1: 3, c2: 4, c3: 5, c4: 6 });
  });
});

describe("an id that is not a path segment, with a value rule", () => {
  it("the preview runtime raises nothing for the write and keeps the other fields", () => {
    const definition = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "ok", type: "text", configuration: { label: "OK" } },
          { id: "a b.c", type: "text", configuration: { label: "L" }, rules: { value: { kind: "literal", value: "1" } } }
        ]
      }
    } as unknown as ComponentNode;
    let runtime: BuilderPreviewRuntime | undefined;
    expect(() => {
      runtime = new BuilderPreviewRuntime(definition);
    }).not.toThrow();
    expect(() => runtime?.setValue("ok", "fine")).not.toThrow();
  });
});
