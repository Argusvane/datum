import { describe, expect, it } from "vitest";

import {
  DEFAULT_PDF_BOX,
  DEFAULT_PDF_CHOICE,
  DEFAULT_PDF_CONTROLS,
  DEFAULT_PDF_FIELDS,
  DEFAULT_PDF_HEADINGS,
  DEFAULT_PDF_LIST,
  DEFAULT_PDF_PANEL,
  DEFAULT_PDF_SPACING,
  DEFAULT_PDF_TABLE,
  DEFAULT_PDF_THEME,
  DEFAULT_PDF_THEME_ID,
  PDF_KERNEL_FALLBACKS,
  PLAIN_PDF_THEME,
  pdfThemeLookup,
  PdfThemeRegistry,
  resolvePdfTheme,
  selectPdfTheme,
  themeFontFaces,
  type PdfThemeDefinition
} from "../form-engine/render/pdf/pdf-theme.js";

const corp: PdfThemeDefinition = { id: "corp", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#123456" } } };
const gov: PdfThemeDefinition = { id: "gov", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#26374a" } } };
const host: PdfThemeDefinition = { id: "host", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#000000" } } };

const lookup = (id: string) => [corp, gov].find((theme) => theme.id === id);

describe("selectPdfTheme", () => {
  it("orders the call's id > the layout's id > the host default > the binding's suggestion > the engine default", () => {
    const binding = { id: "gcds", pdfTheme: corp };
    expect(selectPdfTheme({ themeId: "gov", layoutThemeId: "corp", theme: host, binding, resolveTheme: lookup })).toMatchObject({ theme: gov, source: "call" });
    expect(selectPdfTheme({ layoutThemeId: "corp", theme: host, binding, resolveTheme: lookup })).toMatchObject({ theme: corp, source: "layout" });
    expect(selectPdfTheme({ theme: host, binding, resolveTheme: lookup })).toMatchObject({ theme: host, source: "host" });
    expect(selectPdfTheme({ binding, resolveTheme: lookup })).toMatchObject({ theme: corp, source: "binding" });
    expect(selectPdfTheme({})).toEqual({ theme: undefined, source: "default", warnings: [] });
    expect(selectPdfTheme({ binding: { id: "datum" } })).toEqual({ theme: undefined, source: "default", warnings: [] });
  });

  it("warns about an id nothing supplies and lets the next rung answer", () => {
    const missingLookup = selectPdfTheme({ themeId: "gov", theme: host });
    expect(missingLookup.theme).toBe(host);
    expect(missingLookup.warnings).toEqual([
      { code: "theme.notFound", message: expect.stringContaining('No PDF theme "gov" is registered (asked for by the render call)') }
    ]);

    const unknownLayout = selectPdfTheme({ layoutThemeId: "zzz", resolveTheme: lookup });
    expect(unknownLayout).toMatchObject({ theme: undefined, source: "default" });
    expect(unknownLayout.warnings[0]!.message).toContain("asked for by the layout)");

    const both = selectPdfTheme({ themeId: "zzz", layoutThemeId: "corp", resolveTheme: lookup });
    expect(both).toMatchObject({ theme: corp, source: "layout" });
    expect(both.warnings).toHaveLength(1);
  });

  it("skips a layout's rung when it names a PDF theme that no longer exists, and the next rung answers", () => {
    const selection = selectPdfTheme({ layoutThemeId: "gcds-replica", binding: { id: "gcds", pdfTheme: "gov" }, resolveTheme: lookup });
    expect(selection).toMatchObject({ theme: gov, source: "binding" });
    expect(selection.warnings).toEqual([{ code: "theme.notFound", message: expect.stringContaining('No PDF theme "gcds-replica" is registered (asked for by the layout)') }]);
  });

  it("answers the engine's own datum-pdf and datum-plain ids with no host lookup, so a layout's explicit choice beats the host default", () => {
    // The program passes no resolveTheme: a layout naming the builder picker's "Datum" still gets it.
    expect(selectPdfTheme({ layoutThemeId: DEFAULT_PDF_THEME_ID, theme: host })).toEqual({ theme: DEFAULT_PDF_THEME, source: "layout", warnings: [] });
    expect(selectPdfTheme({ themeId: PLAIN_PDF_THEME.id, theme: host })).toEqual({ theme: PLAIN_PDF_THEME, source: "call", warnings: [] });
    expect(selectPdfTheme({ binding: { id: "gcds", pdfTheme: DEFAULT_PDF_THEME_ID } })).toEqual({ theme: DEFAULT_PDF_THEME, source: "binding", warnings: [] });
    // A host lookup that holds an id of its own answers first, and a lookup that says nothing falls back to the built-ins.
    const own = { ...corp, id: DEFAULT_PDF_THEME_ID };
    expect(selectPdfTheme({ layoutThemeId: DEFAULT_PDF_THEME_ID, resolveTheme: (id) => (id === DEFAULT_PDF_THEME_ID ? own : undefined) }).theme).toBe(own);
    expect(selectPdfTheme({ layoutThemeId: PLAIN_PDF_THEME.id, theme: host, resolveTheme: lookup })).toMatchObject({ theme: PLAIN_PDF_THEME, source: "layout", warnings: [] });
  });

  it("treats an empty id as none", () => {
    expect(selectPdfTheme({ themeId: "", layoutThemeId: "  ", theme: host, resolveTheme: lookup })).toMatchObject({ theme: host, source: "host", warnings: [] });
  });

  it("looks a binding's suggested id up through the host's registry, and warns when it holds none", () => {
    const registry = new PdfThemeRegistry();
    registry.register(corp);
    expect(selectPdfTheme({ binding: { id: "acme", pdfTheme: "corp" }, resolveTheme: pdfThemeLookup(registry) })).toMatchObject({ theme: corp, source: "binding", warnings: [] });
    const missing = selectPdfTheme({ binding: { id: "acme", pdfTheme: "nope" }, resolveTheme: pdfThemeLookup(registry) });
    expect(missing).toMatchObject({ theme: undefined, source: "default" });
    expect(missing.warnings).toEqual([{ code: "theme.notFound", message: expect.stringContaining('(asked for by binding "acme")') }]);
    // No registry: the suggested id cannot be found; a blank one is no suggestion.
    expect(selectPdfTheme({ binding: { id: "acme", pdfTheme: "corp" } }).warnings).toHaveLength(1);
    expect(selectPdfTheme({ binding: { id: "acme", pdfTheme: " " } })).toEqual({ theme: undefined, source: "default", warnings: [] });
  });

  it("refuses a theme of another target at every rung (theme.notPdf) and never derives one", () => {
    const shell = { id: "acme", version: "1.0.0", target: "builder", tokens: { "color-accent": "#123456" } } as unknown as PdfThemeDefinition;
    const byId = (id: string) => (id === "acme" ? shell : id === "corp" ? corp : undefined);
    const call = selectPdfTheme({ themeId: "acme", layoutThemeId: "corp", resolveTheme: byId });
    expect(call).toMatchObject({ theme: corp, source: "layout" });
    expect(call.warnings).toEqual([{ code: "theme.notPdf", message: expect.stringContaining('"acme" (asked for by the render call) is not a PDF theme') }]);

    const asHost = selectPdfTheme({ theme: shell });
    expect(asHost).toMatchObject({ theme: undefined, source: "default" });
    expect(asHost.warnings.map((warning) => warning.code)).toEqual(["theme.notPdf"]);

    const asBinding = selectPdfTheme({ binding: { id: "acme", pdfTheme: shell } });
    expect(asBinding).toMatchObject({ theme: undefined, source: "default" });
    expect(asBinding.warnings[0]!.message).toContain('binding "acme"');
    const byBindingId = selectPdfTheme({ binding: { id: "acme", pdfTheme: "acme" }, resolveTheme: byId });
    expect(byBindingId.warnings.map((warning) => warning.code)).toEqual(["theme.notPdf"]);
  });
});

describe("pdfThemeLookup", () => {
  it("resolves a PDF theme registry by id and leaves an unknown id alone", () => {
    const registry = new PdfThemeRegistry();
    registry.register(corp);
    const find = pdfThemeLookup(registry)!;
    expect(find("corp")).toBe(corp);
    expect(find("nope")).toBeUndefined();
  });

  it("passes a function through and leaves nothing as nothing", () => {
    expect(pdfThemeLookup(lookup)).toBe(lookup);
    expect(pdfThemeLookup(undefined)).toBeUndefined();
  });

  it("feeds resolvePdfTheme: the chosen theme's colours over the defaults", () => {
    const chosen = selectPdfTheme({ layoutThemeId: "gov", resolveTheme: lookup }).theme;
    const resolved = resolvePdfTheme(chosen);
    expect(resolved.id).toBe("gov");
    expect(resolved.colors.accent).toBe("#26374a");
    expect(resolvePdfTheme(undefined).id).toBe(DEFAULT_PDF_THEME_ID);
  });
});

describe("resolvePdfTheme — conformance", () => {
  it("carries a theme's PDF/A level and output intent, and nothing when the theme names none", () => {
    const profile = { storage: "base64", name: "org.icc", type: "application/vnd.iccprofile", size: 4, data: "AAAA" };
    const archive: PdfThemeDefinition = { id: "archive", version: "1.0.0", target: "pdf", pdf: { pdfa: "3u", outputIntent: { profile, identifier: "Org" } } };
    const themed = resolvePdfTheme(archive);
    expect(themed.pdfa).toBe("3u");
    expect(themed.outputIntent).toEqual({ profile, identifier: "Org" });
    // A level the layer cannot produce and an intent with no profile count for nothing.
    const plain = resolvePdfTheme({ id: "plain", version: "1.0.0", target: "pdf", pdf: { pdfa: "1b", outputIntent: { identifier: "no profile" } } as unknown as PdfThemeDefinition["pdf"] } as PdfThemeDefinition);
    expect(plain.pdfa).toBeUndefined();
    expect(plain.outputIntent).toBeUndefined();
    expect(resolvePdfTheme(undefined).pdfa).toBeUndefined();
  });
});

/** A pdf-target theme with the given block and nothing else, typed as one so an inline literal is not read as a builder theme. */
function pdfTheme(pdf: PdfThemeDefinition["pdf"], id = "one"): PdfThemeDefinition {
  return { id, version: "1.0.0", target: "pdf", ...(pdf ? { pdf } : {}) };
}

describe("resolvePdfTheme — the form look and the kernel's fallbacks", () => {
  it("fills a theme that says nothing with the engine's form look", () => {
    const resolved = resolvePdfTheme(undefined);
    expect(resolved.controls).toEqual({ ...DEFAULT_PDF_CONTROLS });
    expect(resolved.choice).toEqual({ ...DEFAULT_PDF_CHOICE });
    expect(resolved.fields).toEqual({ ...DEFAULT_PDF_FIELDS });
    expect(resolved.headings).toEqual({ ...DEFAULT_PDF_HEADINGS });
    expect(resolved.table).toEqual({ ...DEFAULT_PDF_TABLE });
    expect(resolved.box).toEqual({ ...DEFAULT_PDF_BOX });
    expect(resolved.panel).toEqual({ ...DEFAULT_PDF_PANEL });
    expect(resolved.list).toEqual({ ...DEFAULT_PDF_LIST });
    expect(resolved.spacing).toEqual({ ...DEFAULT_PDF_SPACING });
    expect(resolved.components).toEqual({ radio: { rendition: "checklist" } });
    // The HTML engine's own marker, so a form and its PDF agree; the wizard's step line.
    expect(resolved.texts.required).toBe("*");
    expect(resolved.texts.stepOf).toBe("Step {{n}} of {{total}}");
    // Uppercase captions and the seven type roles are the form look's.
    expect(resolved.typography.label).toMatchObject({ weight: 700, transform: "uppercase" });
    for (const role of ["hint", "option", "legend", "required", "small", "affix", "stepTag"] as const) {
      expect(resolved.typography[role], role).toBeDefined();
    }
    // The engine default's own control border is a step darker than its panel grey.
    expect(resolved.colors).toMatchObject({ controlBorder: "#555555", controlFill: "#ffffff", choiceMark: "#111111", link: "#1a4480", onAccent: "#ffffff" });
    expect(resolvePdfTheme(DEFAULT_PDF_THEME)).toEqual(resolved);
  });

  it("resolves the plain theme to the kernel's own fallbacks — the document drawn before the form look", () => {
    const plain = resolvePdfTheme(PLAIN_PDF_THEME);
    expect(plain.id).toBe("datum-plain");
    expect(plain.controls).toEqual({ ...PDF_KERNEL_FALLBACKS.controls });
    expect(plain.choice).toEqual({ ...PDF_KERNEL_FALLBACKS.choice });
    expect(plain.fields).toEqual({ ...PDF_KERNEL_FALLBACKS.fields });
    expect(plain.headings).toEqual({ ...PDF_KERNEL_FALLBACKS.headings });
    expect(plain.table).toEqual({ ...PDF_KERNEL_FALLBACKS.table });
    expect(plain.box).toEqual({ ...PDF_KERNEL_FALLBACKS.box });
    expect(plain.panel).toEqual({ ...PDF_KERNEL_FALLBACKS.panel });
    expect(plain.list).toEqual({ ...PDF_KERNEL_FALLBACKS.list });
    expect(plain.spacing).toEqual({ ...PDF_KERNEL_FALLBACKS.spacing });
    expect(plain.typography.body).toEqual({ family: "sans-serif", size: 10, lineHeight: 1.35 });
    expect(plain.typography.label).toEqual({ family: "sans-serif", size: 8, lineHeight: 1.3, bold: true, color: "#555555" });
    for (const role of ["hint", "option", "legend", "required", "small", "affix", "stepTag"] as const) {
      expect(plain.typography[role], role).toBeUndefined();
    }
    expect(plain.texts.required).toBe("");
    expect(plain.texts.stepOf).toBe("");
    expect(plain.components).toEqual({ radio: {} });
  });

  it("takes a theme's own colours, weights, transforms, heading line heights and geometry over the form look", () => {
    const themed: PdfThemeDefinition = {
      id: "themed",
      version: "1.0.0",
      target: "pdf",
      pdf: {
        typography: {
          body: { family: "Noto Sans", weight: 400 },
          label: { weight: 600, transform: "none" },
          heading: { lineHeights: [1.5, 1.4] },
          hint: null,
          option: { weight: 500 }
        },
        colors: { border: "#8c8c8c", controlBorder: "#333333", link: "#1f497a" },
        controls: { borderWidth: 1.5, minHeight: 36, textareaRows: 5, fontSize: 15, maxWidth: 640 },
        choice: { size: 36, dotSize: 13.5, columns: 2 },
        fields: { hintPosition: "afterControl", inlineLabelWidth: { fraction: 0.3 } },
        headings: { numbered: false, band: "accent" },
        spacing: { labelValue: [0, 18], heading: null },
        texts: { required: "(required)" }
      }
    };
    const resolved = resolvePdfTheme(themed);
    expect(resolved.typography.body).toMatchObject({ family: "Noto Sans", weight: 400, size: 10 });
    // The optional roles follow the body's family when the theme gives them no family of their own.
    expect(resolved.typography.option).toMatchObject({ family: "Noto Sans", weight: 500 });
    expect(resolved.typography.legend?.family).toBe("sans-serif");
    expect(resolved.typography.label).toMatchObject({ weight: 600, transform: "none" });
    expect(resolved.typography.heading.lineHeights).toEqual([1.5, 1.4]);
    expect(resolved.typography.hint).toBeUndefined();
    expect(resolved.colors).toMatchObject({ border: "#8c8c8c", controlBorder: "#333333", link: "#1f497a", choiceMark: "#111111" });
    expect(resolved.controls).toMatchObject({ borderWidth: 1.5, minHeight: 36, textareaRows: 5, fontSize: 15, maxWidth: 640, radius: 2 });
    expect(resolved.choice).toMatchObject({ size: 36, dotSize: 13.5, columns: 2, widgetSize: 11 });
    expect(resolved.fields).toMatchObject({ hintPosition: "afterControl", inlineLabelWidth: { fraction: 0.3 } });
    expect(resolved.headings).toMatchObject({ numbered: false, band: "accent" });
    expect(resolved.spacing.labelValue).toEqual([0, 18]);
    // A kind set to null is left to the kernel's own table.
    expect(resolved.spacing.heading).toBeUndefined();
    expect(resolved.texts.required).toBe("(required)");
  });

  it("falls back for what a theme gets wrong, field by field", () => {
    const wrong = {
      id: "wrong",
      version: "1.0.0",
      target: "pdf",
      pdf: {
        controls: { borderWidth: -1, valueFrame: "circle", textareaRows: 2.5 },
        choice: { columns: 0 },
        fields: { hints: "sometimes", inlineLabelWidth: { fraction: 2 } },
        headings: { band: "stripes" },
        spacing: { heading: [1], widget: ["a", "b"] },
        list: { bullet: "" }
      }
    } as unknown as PdfThemeDefinition;
    const resolved = resolvePdfTheme(wrong);
    expect(resolved.controls).toMatchObject({ borderWidth: DEFAULT_PDF_CONTROLS.borderWidth, valueFrame: "box", textareaRows: DEFAULT_PDF_CONTROLS.textareaRows });
    expect(resolved.choice.columns).toBe(1);
    expect(resolved.fields.hints).toBe("shown");
    expect(resolved.fields.inlineLabelWidth).toBeUndefined();
    expect(resolved.headings.band).toBe("surface");
    expect(resolved.spacing.heading).toEqual(DEFAULT_PDF_SPACING.heading);
    expect(resolved.spacing.widget).toEqual(DEFAULT_PDF_SPACING.widget);
    expect(resolved.list.bullet).toBe("•");
  });

  it("scales every point size and gap, and nothing that is a ratio, a count or a fraction", () => {
    const half = resolvePdfTheme(
      pdfTheme({ scale: 0.5, fields: { inlineLabelWidth: 100 }, components: { text: { style: { spacingAfter: 10, width: 200, size: 12, ruledLines: 3 } } } }, "half")
    );
    const whole = resolvePdfTheme(undefined);
    expect(half.typography.body.size).toBe(whole.typography.body.size / 2);
    expect(half.typography.body.lineHeight).toBe(whole.typography.body.lineHeight);
    expect(half.typography.heading.sizes).toEqual(whole.typography.heading.sizes.map((size) => size / 2));
    expect(half.typography.hint?.size).toBe(whole.typography.hint!.size / 2);
    expect(half.controls).toMatchObject({ borderWidth: whole.controls.borderWidth / 2, minHeight: whole.controls.minHeight / 2, fontSize: whole.controls.fontSize! / 2, textareaRows: whole.controls.textareaRows });
    expect(half.choice).toMatchObject({ size: whole.choice.size / 2, columns: whole.choice.columns });
    expect(half.fields).toMatchObject({ labelToValue: whole.fields.labelToValue / 2, inlineLabelWidth: 50 });
    expect(half.spacing.labelValue).toEqual([0, whole.spacing.labelValue![1] / 2]);
    expect(half.table.cellPadding).toBe(whole.table.cellPadding / 2);
    expect(half.components.text?.style).toEqual({ spacingAfter: 5, width: 100, size: 6, ruledLines: 3 });
    expect(half.page).toBeUndefined();
    // A scale of 1, or nonsense, changes nothing.
    const bare = resolvePdfTheme(pdfTheme({}));
    expect(resolvePdfTheme(pdfTheme({ scale: 1 }))).toEqual(bare);
    expect(resolvePdfTheme(pdfTheme({ scale: -3 }))).toEqual(bare);
  });

  it("lists the faces a theme ships and drops malformed entries", () => {
    const faces = themeFontFaces({
      id: "faces",
      version: "1.0.0",
      target: "pdf",
      assets: {
        fonts: [
          { family: "Noto Sans", weight: 600, style: "normal", file: "gcds-fonts/pdf/noto-sans-600.ttf", coverage: ["Latn"] },
          { family: "Lato", file: "gcds-fonts/pdf/lato-700.ttf", weight: -700, style: "oblique" as "italic" },
          { family: "", file: "nothing.ttf" },
          { family: "Nameless" } as unknown as { family: string; file: string }
        ]
      }
    } as PdfThemeDefinition);
    expect(faces).toEqual([
      { family: "Noto Sans", weight: 600, style: "normal", file: "gcds-fonts/pdf/noto-sans-600.ttf", coverage: ["Latn"] },
      { family: "Lato", file: "gcds-fonts/pdf/lato-700.ttf" }
    ]);
    expect(themeFontFaces(undefined)).toEqual([]);
    expect(themeFontFaces(DEFAULT_PDF_THEME)).toEqual([]);
  });
});
