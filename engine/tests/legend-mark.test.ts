// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { collectFieldConstraints } from "../form-engine/validation/core/field-constraints.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { runsText, walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { html as litHtml } from "../form-engine/render/live/lit.js";
import type { DatumParts } from "../form-engine/render/live/datum/parts.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

/**
 * A fieldset's legend mark: `configuration.legendMark` of
 * "required" or "optional", drawn through the labelMarks part in the legend, presentational only.
 */
function treeWith(fieldsetConfiguration: Record<string, unknown>): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "height",
          type: "fieldset",
          configuration: { label: "Height", ...fieldsetConfiguration },
          children: { content: [{ id: "feet", type: "text", configuration: { label: "Feet" } }] }
        }
      ]
    }
  };
}

async function html(fieldsetConfiguration: Record<string, unknown>, options: { texts?: Record<string, string>; parts?: DatumParts } = {}): Promise<string> {
  unmountAll();
  const drawn = await markupOf(treeWith(fieldsetConfiguration), {
    ...(options.parts ? { binding: { parts: options.parts } } : {}),
    ...(options.texts ? { mount: { texts: options.texts as never } } : {})
  });
  return drawn.html;
}

const legendOf = (markup: string): string => markup.match(/<legend[^>]*>[\s\S]*?<\/legend>/)?.[0] ?? "";
const words = { required: "(Required)", optional: "(Optional)" } as never;

describe("a fieldset's legend mark", () => {
  it("draws nothing without the flag: the legend is unchanged", async () => {
    const legend = legendOf(await html({}, { texts: words }));
    expect(legend).toBe('<legend id="height__group-label" class="datum-form__group-label">Height</legend>');
    expect(legendOf(await html({ legendMark: "sometimes" }, { texts: words }))).toBe(legend);
    expect(legendOf(await html({ legendMark: true }, { texts: words }))).toBe(legend);
  });

  it("draws the required mark through the labelMarks default, announced", async () => {
    const legend = legendOf(await html({ legendMark: "required" }, { texts: words }));
    expect(legend).toBe(
      '<legend id="height__group-label" class="datum-form__group-label">Height <span class="datum-form__required">(Required)</span></legend>'
    );
    expect(legend).not.toContain("aria-hidden");
  });

  it("draws the optional mark, and nothing while the theme words no optional mark", async () => {
    expect(legendOf(await html({ legendMark: "optional" }, { texts: words }))).toContain('<span class="datum-form__optional">(Optional)</span>');
    expect(legendOf(await html({ legendMark: "optional" }))).toBe('<legend id="height__group-label" class="datum-form__group-label">Height</legend>');
    expect(legendOf(await html({ legendMark: "required" }))).toContain(">*</span>");
  });

  it("goes through the theme's labelMarks part, with the legend's announced flag", async () => {
    const seen: Array<{ required: boolean; announced: boolean }> = [];
    const parts: DatumParts = {
      labelMarks: (part) => {
        seen.push({ required: part.required, announced: part.announced });
        return litHtml` <b class="flag">${part.marker}</b>`;
      }
    };
    const legend = legendOf(await html({ legendMark: "optional" }, { texts: words, parts }));
    expect(legend).toContain('Height <b class="flag">(Optional)</b>');
    expect(seen).toContainEqual({ required: false, announced: true });
  });

  it("stays in a hidden legend, and the group is still named by it", async () => {
    const markup = await html({ legendMark: "required", hideLabel: true }, { texts: words });
    expect(legendOf(markup)).toContain("datum-form__visually-hidden");
    expect(legendOf(markup)).toContain("(Required)");
    expect(markup).toContain('aria-labelledby="height__group-label"');
  });

  it("is presentational: the validators collect no constraint from it and no child is marked required", async () => {
    const constraints = collectFieldConstraints(treeWith({ legendMark: "required" }));
    expect(constraints).toEqual([]);
    const markup = await html({ legendMark: "required" }, { texts: words });
    expect(markup).not.toContain('aria-required="true"');
  });
});

describe("a fieldset's legend mark on paper", () => {
  const theme: PdfThemeDefinition = {
    id: "marks",
    version: "1.0.0",
    target: "pdf",
    pdf: { texts: { required: { default: "(Required)" } } }
  };

  async function headingOf(fieldsetConfiguration: Record<string, unknown>, pdfTheme?: PdfThemeDefinition): Promise<string | undefined> {
    const state = { ...new FormStateStore("en").snapshot(), values: { feet: "5" } };
    const model = await buildPdfRenderModel(treeWith(fieldsetConfiguration), state, { resolveDataSource: async () => undefined }, { locale: "en" }, pdfTheme ? { theme: pdfTheme } : {});
    const blocks: PdfBlock[] = [];
    walkPdfBlocks(model.document?.blocks ?? [], (block) => blocks.push(block));
    const heading = blocks.find((block) => block.kind === "heading" && runsText(block.runs).startsWith("Height"));
    return heading?.kind === "heading" ? runsText(heading.runs) : undefined;
  }

  it("words the required mark after the section heading, as the form's legend does", async () => {
    expect(await headingOf({ legendMark: "required" }, theme)).toBe("Height (Required)");
  });

  it("draws nothing without the flag, for the optional mark, or when the theme words no required text", async () => {
    expect(await headingOf({}, theme)).toBe("Height");
    expect(await headingOf({ legendMark: "optional" }, theme)).toBe("Height");
    expect(await headingOf({ legendMark: "required" }, { ...theme, pdf: { texts: { required: { default: "" } } } })).toBe("Height");
    // The engine's own default theme words a required marker, as it does for a required field.
    expect(await headingOf({ legendMark: "required" })).toBe("Height *");
  });
});
