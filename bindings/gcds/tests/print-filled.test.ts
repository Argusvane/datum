// Not type-checked with the package (it uses vitest and the engine's sources): run with the kernel's vitest, `npm run test:print-filled`.
// The GCDS print theme's `filled` rendition as markup: the paper form's boxes with the answers written in. What
// the browser makes of the sheet (no clipping, the fonts) is `npm run test:print`'s; this holds the markup and the rules.
import { describe, expect, it } from "vitest";
import { SubmissionModeRegistry } from "../../../engine/form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../../engine/form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../../../engine/form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../../../engine/form-engine/validation/core/field-constraints.js";
import { normalizeDataGrids } from "../../../engine/form-engine/core/schema/data-grid.js";
import { EagerJourneyRenderKit } from "../../../engine/form-engine/render/core/journey-render-kit-eager.js";
import { buildPrintDocument, buildPrintModel, type PrintModel } from "../../../engine/form-engine/render/print/index.js";
import type { FormDefinition } from "../../../engine/form-engine/core/schema/types.js";
import { gcdsPrintTheme } from "../print/index.js";
import contract from "../tokens.json" with { type: "json" };

const form = {
  id: "gcds-filled",
  version: "1",
  schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
  root: {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name", required: true } },
        { id: "weight", type: "number", configuration: { label: "Weight", suffix: "kg" } },
        { id: "born", type: "date", configuration: { label: "Born" } },
        { id: "city", type: "select", configuration: { label: "City", options: [{ value: "ott", label: "Ottawa" }, { value: "tor", label: "Toronto" }] } },
        { id: "ref", type: "text", configuration: { label: "Reference" } },
        {
          id: "items",
          type: "dataGrid",
          configuration: { label: "Items" },
          collection: { collectionPath: "items" },
          children: { content: [{ id: "qty", type: "number", configuration: { label: "Quantity", suffix: "kg" } }, { id: "sku", type: "text", configuration: { label: "SKU" } }] }
        }
      ]
    }
  }
} as unknown as FormDefinition;

async function modelOf(rendition: "answers" | "blank" | "filled", locale?: string, long?: string, city: string | undefined = "tor"): Promise<PrintModel> {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(form.root))]) });
  runtime.setValue("name", long ?? "Ada Lovelace");
  runtime.setValue("weight", 70);
  runtime.setValue("born", "2026-03-15");
  if (city !== undefined) {
    runtime.setValue("city", city);
  }
  runtime.setValue("items[0].qty", 3);
  runtime.setValue("items[0].sku", "A-1");
  runtime.addRow("items");
  runtime.setValue("items[1].qty", 5);
  return buildPrintModel(runtime, { rendition, ...(locale ? { locale } : {}), render: { journeyKit: EagerJourneyRenderKit } });
}

/** The markup of one component's wrapper (to the next wrapper), and the text of what matches in it. */
const chunk = (html: string, id: string): string => {
  const at = html.indexOf(`data-component-id="${id}"`);
  const next = html.indexOf("data-component-id=", at + 1);
  return html.slice(at, next === -1 ? undefined : next);
};
const texts = (markup: string, pattern: RegExp): string[] => [...markup.matchAll(pattern)].map((match) => match[1] ?? "");

describe("the GCDS print theme, filled", () => {
  it("draws the answers in the form's boxes: values, affixes beside, date parts, marked choices, an empty box, no words for what is missing", async () => {
    const html = buildPrintDocument(await modelOf("filled"), { theme: gcdsPrintTheme });
    expect(html).toContain("datum-print--filled");
    expect(texts(chunk(html, "name"), /gp-box--filled[^>]*>([^<]*)</g)).toEqual(["Ada Lovelace"]);
    expect(texts(chunk(html, "weight"), /gp-box--filled[^>]*>([^<]*)</g)).toEqual(["70"]);
    expect(texts(chunk(html, "weight"), /class="gp-affix">([^<]*)</g)).toEqual(["kg"]);
    expect(texts(chunk(html, "born"), /gp-date__label">([^<]*)<\/span><span class="gp-box gp-box--filled">([^<]*)</g)).toEqual(["Month", "Day", "Year"]);
    expect(texts(chunk(html, "born"), /gp-box gp-box--filled">([^<]*)</g)).toEqual(["March", "15", "2026"]);
    expect(texts(chunk(html, "city"), /class="gp-choice gp-choice--radio( is-chosen)?"/g)).toEqual(["", " is-chosen"]);
    expect(texts(chunk(html, "ref"), /gp-box--filled[^>]*>([^<]*)</g)).toEqual([""]);
    expect(texts(chunk(html, "items"), /<tr>(.*?)<\/tr>/g).map((row) => row.replace(/<[^>]*>/g, ""))).toEqual(["#QuantitySKU", "13kgA-1", "25kg"]);
    expect(html).not.toContain("Not answered");
    expect(html).not.toContain('class="gp-req"');
    // The blank form still marks what is required, and the answers print still says what is missing.
    expect(buildPrintDocument(await modelOf("blank"), { theme: gcdsPrintTheme })).toContain('class="gp-req"');
    expect(buildPrintDocument(await modelOf("answers", undefined, ""), { theme: gcdsPrintTheme })).toContain("Not answered");
  });

  it("says an unanswered choice in words alone on the answers copy, and keeps its options on a blank or filled form", async () => {
    const answers = chunk(buildPrintDocument(await modelOf("answers", undefined, undefined, ""), { theme: gcdsPrintTheme }), "city");
    expect(answers).toContain("Not answered");
    expect(answers).not.toContain("gp-choices");
    for (const rendition of ["blank", "filled"] as const) {
      const paper = chunk(buildPrintDocument(await modelOf(rendition, undefined, undefined, ""), { theme: gcdsPrintTheme }), "city");
      expect(paper).toContain("gp-choices");
      expect(paper).not.toContain("Not answered");
    }
  });

  it("words the date in French order and keeps a long unbroken value in a box that grows", async () => {
    const french = buildPrintDocument(await modelOf("filled", "fr"), { theme: gcdsPrintTheme });
    expect(texts(chunk(french, "born"), /gp-date__part--(\w+)"/g)).toEqual(["day", "month", "year"]);
    expect(texts(chunk(french, "born"), /gp-box gp-box--filled">([^<]*)</g)).toEqual(["15", "mars", "2026"]);
    const long = "x".repeat(400);
    const html = buildPrintDocument(await modelOf("filled", undefined, long), { theme: gcdsPrintTheme });
    expect(texts(chunk(html, "name"), /gp-box--filled[^>]*>([^<]*)</g)).toEqual([long]);
    const css = html.slice(html.indexOf("<style"), html.lastIndexOf("</style>"));
    const rule = /\.gp-box--filled \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("min-height:");
    expect(rule).not.toMatch(/(^|[^-])height:/);
    expect(css).toMatch(/\.gp-answer, \.gp-box \{[^}]*overflow-wrap: anywhere/);
    // The affix rules that keep the box wide and the affix whole belong to the filled form: the blank form keeps the plain ones, and a long affix wraps rather than running off the page.
    expect(css).toMatch(/\.datum-print--filled \.gp-affixed \.gp-box \{[^}]*min-width: 8em/);
    expect(css).toMatch(/\.datum-print--filled \.gp-affix \{[^}]*flex: 0 0 auto[^}]*max-width: 40%[^}]*overflow-wrap: break-word/);
    expect(css).toMatch(/\.gp-affixed \.gp-box \{ margin: 0; flex: 1; \}/);
    expect(css).not.toMatch(/(^|\n)\.gp-affix \{[^}]*(flex: none|white-space: nowrap)/);
    expect(css).not.toMatch(/(^|\n)\.gp-affixed \.gp-box \{[^}]*min-width/);
  });

  it("draws a date in a table cell as one line in the language's words, never its parts joined by spaces", async () => {
    const grid = {
      ...form,
      root: {
        ...form.root,
        children: {
          content: [
            {
              id: "events",
              type: "dataGrid",
              configuration: { label: "Events" },
              collection: { collectionPath: "events" },
              children: { content: [{ id: "on", type: "date", configuration: { label: "On" } }] }
            }
          ]
        }
      }
    } as unknown as FormDefinition;
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(grid, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(grid.root))]) });
    runtime.setValue("events[0].on", "2026-03-15");
    for (const [locale, words] of [
      ["en-US", "March 15, 2026"],
      ["fr", "15 mars 2026"]
    ] as const) {
      const model = await buildPrintModel(runtime, { rendition: "filled", locale, render: { journeyKit: EagerJourneyRenderKit } });
      const html = buildPrintDocument(model, { theme: gcdsPrintTheme });
      expect(texts(chunk(html, "events"), /<td class="datum-print__answer">([^<]*)</g), locale).toEqual([words]);
    }
  });

  it("declares the three renditions it draws, so a filled form is never drawn by its answers shapes", () => {
    expect(gcdsPrintTheme.renditions).toEqual(["answers", "blank", "filled"]);
  });
});

describe("the GCDS print theme, a panel's look", () => {
  const LOOKS = ["plain", "outlined", "shaded", "card"] as const;
  const panel = (id: string, cssClass?: string, type = "panel") => ({
    id,
    type,
    configuration: { label: `Box ${id}`, ...(cssClass !== undefined ? { cssClass } : {}) },
    children: { content: [{ id: `${id}-field`, type: "text", configuration: { label: `Field ${id}` } }] }
  });
  const looks = {
    id: "gcds-looks",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Looks" },
      children: { content: [...LOOKS.map((look) => panel(look, `panel-${look}`)), panel("none"), panel("fieldset", "panel-card", "fieldset")] }
    }
  } as unknown as FormDefinition;

  it("puts the look on the group's element in every rendition and carries its rules in the sheet, from tokens the contract lists", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(looks, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(normalizeDataGrids(looks.root))]) });
    for (const rendition of ["answers", "blank", "filled"] as const) {
      const model = await buildPrintModel(runtime, { rendition, render: { journeyKit: EagerJourneyRenderKit } });
      const html = buildPrintDocument(model, { theme: gcdsPrintTheme });
      for (const look of LOOKS) {
        expect(chunk(html, look), `${rendition} ${look}`).toContain(`<section class="gp-group gp-group--${look}">`);
      }
      expect(chunk(html, "none")).toContain('<section class="gp-group">');
      expect(chunk(html, "fieldset")).toContain('<section class="gp-group">');
      expect(chunk(html, "card")).toMatch(/<h2 class="gp-legend gp-legend--2 datum-print__keep">Box card<\/h2>/);
    }
    const css = gcdsPrintTheme.css;
    expect(css).toMatch(/\.gp-group--outlined, \.gp-group--card \{ border: var\(--gcds-border-width-sm\) solid var\(--gcds-border-default\)/);
    expect(css).toMatch(/\.gp-group--shaded \{ background: var\(--gcds-bg-light\);[^}]*print-color-adjust: exact/);
    expect(css).toMatch(/\.gp-group--card > \.gp-legend \{[^}]*background: var\(--gcds-bg-light\)/);
    expect(css).toMatch(/-webkit-box-decoration-break: clone; box-decoration-break: clone/);
    // Every token the looks read is one the contract lists, so the self-check covers them.
    const listed = new Set(contract.tokens.map((entry) => entry.name));
    const used = new Set([...css.matchAll(/\.gp-group--[^{]*\{([^}]*)\}/g)].flatMap((rule) => [...(rule[1] ?? "").matchAll(/var\((--gcds-[a-z0-9-]+)\)/g)].map((match) => match[1] as string)));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      expect(listed.has(name), name).toBe(true);
    }
  });
});
