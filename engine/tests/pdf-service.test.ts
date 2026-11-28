import { describe, expect, it } from "vitest";
import { MAX_PDF_TEMPLATE_BYTES, builtinProfileSource } from "../form-engine/core/schema/pdf-layout.js";

import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import type { PdfConfiguration, PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { PdfThemeRegistry } from "../form-engine/render/pdf/pdf-theme-registry.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { PdfKernelError, type PdfKernelRequest } from "../form-engine/render/pdf/pdf-abi.js";
import { walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";
import { createPdfRenditionResolver, type PdfRenditionResolverOptions } from "../form-engine/render/pdf/pdf-renditions.js";
import { pdfFileName, renderFormPdf, resolvePdfImages } from "../form-engine/render/pdf/pdf-service.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { PdfRenditionRegistry } from "../form-engine/registry/pdf/pdf-rendition-registry.js";

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function root(): ComponentNode {
  return {
    id: "intake",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Name" } },
        { id: "logo", type: "image", configuration: { src: "https://example.test/logo.png", alt: "Logo" } }
      ]
    }
  };
}

/** A form whose title and one label are authored in English; French is the definition's map. */
function bilingualRoot(): ComponentNode {
  return {
    id: "intake",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [{ id: "name", type: "text", configuration: { label: "Name" } }]
    }
  };
}

const FRENCH: FormTranslations = {
  fr: {
    form: { title: { text: "Admission", source: sourceHash("Intake") } },
    components: { name: { label: { text: "Nom", source: sourceHash("Name") } } }
  }
};

const BILINGUAL: LocalizationConfiguration = { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" };

function runtime(
  pdf?: PdfConfiguration,
  options: { root?: ComponentNode; localization?: LocalizationConfiguration; translations?: FormTranslations; renditionSources?: PdfRenditionResolverOptions } = {}
): RenderableRuntime & { state: () => FormState } {
  const form = options.root ?? root();
  const state: FormState = {
    values: { name: "Ada" },
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
  return {
    formRoot: () => form,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(form),
    resolveDataSource: async () => undefined,
    pdfConfiguration: () => pdf,
    ...(options.localization ? { localization: () => options.localization } : {}),
    ...(options.translations ? { translations: () => options.translations } : {}),
    ...(options.renditionSources ? { pdfRenditionSources: () => options.renditionSources! } : {})
  };
}

function blocksOf(request: PdfKernelRequest | undefined): PdfBlock[] {
  const out: PdfBlock[] = [];
  if (request?.op === "render") {
    walkPdfBlocks(request.document.blocks, (block) => out.push(block));
  }
  return out;
}

function provider(): PdfRenderProvider & { requests: PdfKernelRequest[] } {
  const requests: PdfKernelRequest[] = [];
  return {
    id: "fake",
    abiVersion: "1.0.0",
    requests,
    render: async (request) => {
      requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 2, pages: [], warnings: [{ code: "font.fallback_standard14", message: "Helvetica" }], providerId: "fake" };
    },
    fill: async (request) => {
      requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [{ pdfField: "Name", status: "filled" }] };
    }
  };
}

const environment = { now: () => "2026-09-05T10:11:12.345Z", newDocumentId: () => "doc-1" };

describe("renderFormPdf", () => {
  it("builds the document, resolves fonts and images, and hands the provider one render request", async () => {
    const fake = provider();
    const result = await renderFormPdf(
      runtime(),
      {
        provider: fake,
        environment,
        fonts: { resolve: async (need) => [{ id: "sans", family: need.families[0]!, data: "AAAA" }] },
        images: { resolve: async (url) => (url.endsWith("logo.png") ? { type: "image/png", data: "iVBORw0KGgo=" } : undefined) }
      },
      { render: { compact: true } }
    );
    expect(result.bytes).toBe(PDF_MAGIC);
    expect(result.layoutKind).toBe("derived");
    expect(result.layoutId).toBe("default");
    expect(result.fileName).toBe("intake-default-20260905-101112.pdf");
    expect(result.pageCount).toBe(2);
    expect(result.warnings).toEqual([{ code: "font.fallback_standard14", message: "Helvetica" }]);

    const request = fake.requests[0]!;
    expect(request.op).toBe("render");
    if (request.op !== "render") {
      return;
    }
    expect(request.env).toEqual({ createdAt: "2026-09-05T10:11:12.345Z", documentId: "doc-1" });
    expect(request.options).toEqual({ compact: true });
    expect(request.fonts).toEqual([{ id: "sans", family: "sans-serif", data: "AAAA" }]);
    expect(Object.values(request.document.resources.images)).toEqual([{ type: "image/png", data: "iVBORw0KGgo=" }]);
    expect(request.document.metadata.title).toBe("Intake");
  });

  it("tells the font provider which PDF theme the document renders under and carries the faces it reports as warnings", async () => {
    const fake = provider();
    const gcds: PdfThemeDefinition = {
      id: "gcds",
      version: "1.0.0",
      target: "pdf",
      pdf: { typography: { body: { family: "Lato" } } },
      assets: { fonts: [{ family: "Lato", file: "lato-400.woff" }] }
    };
    const needs: Array<{ themeId: string | undefined; faces: unknown }> = [];
    const result = await renderFormPdf(
      runtime(),
      {
        provider: fake,
        environment,
        binding: { id: "gcds", pdfTheme: gcds },
        fonts: {
          resolve: async (need) => {
            needs.push({ themeId: need.themeId, faces: need.faces });
            need.warn?.({ code: "font.faceFailed", message: "lato-400.woff could not be loaded" });
            return [];
          }
        }
      },
      {}
    );
    expect(needs).toEqual([{ themeId: "gcds", faces: [{ family: "Lato", file: "lato-400.woff" }] }]);
    expect(result.themeId).toBe("gcds");
    expect(result.warnings).toContainEqual({ code: "font.faceFailed", message: "lato-400.woff could not be loaded" });
  });

  it("warns and keeps going when an image cannot be resolved, or nothing resolves images", async () => {
    const fake = provider();
    const noResolver = await renderFormPdf(runtime(), { provider: fake, environment });
    expect(noResolver.warnings.map((w) => w.code)).toEqual(["image.unresolved", "font.fallback_standard14"]);
    const failing = await renderFormPdf(runtime(), {
      provider: fake,
      environment,
      images: { resolve: async () => { throw new Error("offline"); } }
    });
    expect(failing.warnings[0]).toMatchObject({ code: "image.unresolved", message: expect.stringContaining("offline") });
  });

  it("renders under the theme a layout names, looked up in the host's registry, and lets themeId override it", async () => {
    const registry = new PdfThemeRegistry();
    registry.register({ id: "corp", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#123456" } } } as PdfThemeDefinition);
    registry.register({ id: "plain", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#abcdef" } } } as PdfThemeDefinition);
    const layout: PdfGeneratedLayout = {
      id: "letter",
      kind: "generated",
      theme: "corp",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } }
    };
    const fake = provider();

    const byLayout = await renderFormPdf(runtime(), { provider: fake, environment, themes: registry }, { layout });
    expect(byLayout.themeId).toBe("corp");
    expect(byLayout.document!.colors.accent).toBe("#123456");
    expect(byLayout.warnings.map((w) => w.code)).not.toContain("theme.notFound");

    const byCall = await renderFormPdf(runtime(), { provider: fake, environment, themes: registry }, { layout, themeId: "plain" });
    expect(byCall.themeId).toBe("plain");
    expect(byCall.document!.colors.accent).toBe("#abcdef");

    const unknown = await renderFormPdf(runtime(), { provider: fake, environment, themes: registry }, { layout, themeId: "zzz" });
    expect(unknown.themeId).toBe("corp");
    expect(unknown.warnings[0]).toMatchObject({ code: "theme.notFound", message: expect.stringContaining('"zzz"') });
    expect(unknown.bytes).toBe(PDF_MAGIC);

    const noRegistry = await renderFormPdf(runtime(), { provider: fake, environment }, { layout });
    expect(noRegistry.themeId).toBe("datum-pdf");
    expect(noRegistry.warnings[0]).toMatchObject({ code: "theme.notFound" });
  });

  it("prints under the PDF theme the binding suggests when neither the call, the layout nor the host names one", async () => {
    const layout: PdfGeneratedLayout = {
      id: "letter",
      kind: "generated",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } }
    };
    const fake = provider();
    const acme: PdfThemeDefinition = { id: "acme", version: "1.0.0", target: "pdf", pdf: { colors: { accent: "#abcdef" } } };

    // The suggestion as the theme itself.
    const byObject = await renderFormPdf(runtime(), { provider: fake, environment, binding: { id: "acme", pdfTheme: acme } }, { layout });
    expect(byObject.themeId).toBe("acme");
    expect(byObject.document!.colors.accent).toBe("#abcdef");

    // The suggestion as an id the host's registry holds.
    const registry = new PdfThemeRegistry();
    registry.register(acme);
    const byId = await renderFormPdf(runtime(), { provider: fake, environment, themes: registry, binding: { id: "acme", pdfTheme: "acme" } }, { layout });
    expect(byId.themeId).toBe("acme");
    expect(byId.document!.colors.accent).toBe("#abcdef");

    // A binding that suggests none keeps the engine's own PDF theme.
    const none = await renderFormPdf(runtime(), { provider: fake, environment, binding: { id: "datum" } }, { layout });
    expect(none.themeId).toBe("datum-pdf");
  });

  it("fills a template layout through the provider's fill, with the inline template's bytes", async () => {
    const fake = provider();
    const pdf: PdfConfiguration = {
      layouts: [
        {
          id: "gov",
          kind: "template",
          template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
          fields: [{ pdfField: "Name", source: { kind: "component", componentId: "name" } }]
        }
      ]
    };
    const result = await renderFormPdf(runtime(pdf), { provider: fake, environment }, { layoutId: "gov" });
    expect(result.layoutKind).toBe("template");
    expect(result.fields).toEqual([{ pdfField: "Name", status: "filled" }]);
    expect(result.fileName).toBe("intake-gov-20260905-101112.pdf");
    const request = fake.requests[0]!;
    expect(request.op).toBe("fill");
    if (request.op === "fill") {
      expect(request.template.data).toBe("JVBERi0=");
      expect(request.values).toEqual({ Name: "Ada" });
      expect(request.options).toEqual({ flatten: false, readOnly: false, appearances: "regenerate" });
    }
  });

  it("sends the areas, a fillable one with its field, and reports what the provider drew", async () => {
    const template = { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" };
    const areas = [
      { id: "a", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "component" as const, componentId: "name" } },
      { id: "f", page: 1, rect: { x: 0, y: 20, width: 10, height: 10 }, source: { kind: "component" as const, componentId: "name" }, field: { name: "applicant" } }
    ];
    const pdf: PdfConfiguration = { layouts: [{ id: "paper", kind: "template", template, fields: [], areas }] };
    const current = provider();
    current.fill = async (request) => {
      current.requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [], areas: [{ id: "a", page: 1, status: "filled" }, { id: "f", page: 1, status: "filled", field: "applicant" }] };
    };
    const currentResult = await renderFormPdf(runtime(pdf), { provider: current, environment }, { layoutId: "paper" });
    expect(currentResult.warnings).toEqual([]);
    expect(currentResult.areas?.[1]).toEqual({ id: "f", page: 1, status: "filled", field: "applicant" });
    const request = current.requests[0]!;
    if (request.op === "fill") {
      expect(request.areas?.[1]).toMatchObject({ id: "f", value: "Ada", field: { name: "applicant", required: false, readOnly: false } });
    }
  });

  it("refuses a provider of another PDF ABI major, or with no usable version, before anything is built", async () => {
    for (const abiVersion of ["0.18.0", "2.0.0", "1.0", "", undefined]) {
      const other = { ...provider(), abiVersion } as unknown as ReturnType<typeof provider>;
      const failure = await renderFormPdf(runtime(), { provider: other, environment }).catch((error: unknown) => error);
      expect(failure, String(abiVersion)).toBeInstanceOf(PdfKernelError);
      expect(failure, String(abiVersion)).toMatchObject({ code: "abi_mismatch" });
      expect(other.requests).toEqual([]);
    }
    expect((await renderFormPdf(runtime(), { provider: { ...provider(), abiVersion: "1.7.1" }, environment })).bytes).toBe(PDF_MAGIC);
  });

  it("refuses a resolved template over the 25 MiB cap with the template error, before the provider is called", async () => {
    const fake = provider();
    const pdf: PdfConfiguration = {
      layouts: [{ id: "t", kind: "template", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 1, data: "AA==" }, fields: [] }]
    };
    const big = new Uint8Array(MAX_PDF_TEMPLATE_BYTES + 1);
    const failure = await renderFormPdf(runtime(pdf), { provider: fake, environment, templates: { resolve: async () => big } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "template" });
    expect((failure as Error).message).toContain(String(big.length));
    expect((failure as Error).message).toContain("25 MiB");
    expect(fake.requests).toEqual([]);
  });

  it("refuses a template layout on a provider that cannot fill", async () => {
    const { fill: _fill, ...renderOnly } = provider();
    const pdf: PdfConfiguration = {
      layouts: [{ id: "t", kind: "template", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 1, data: "AA==" }, fields: [] }]
    };
    await expect(renderFormPdf(runtime(pdf), { provider: renderOnly, environment })).rejects.toThrow(/cannot fill/);
  });

  it("warns about a component type with no rendition by default, and refuses it under unknownComponents: fail", async () => {
    const survey: ComponentNode = {
      id: "survey",
      type: "form",
      configuration: { title: "Survey" },
      children: { content: [{ id: "stars", type: "rating", configuration: { label: "Stars" } }] }
    };
    const warned = await renderFormPdf(runtime(undefined, { root: survey }), { provider: provider(), environment });
    expect(warned.warnings).toContainEqual(expect.objectContaining({ code: "component.unknown", componentId: "stars" }));
    const quiet = await renderFormPdf(runtime(undefined, { root: survey }), { provider: provider(), environment }, { unknownComponents: "ignore" });
    expect(quiet.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);
    const fake = provider();
    await expect(renderFormPdf(runtime(undefined, { root: survey }), { provider: fake, environment }, { unknownComponents: "fail" })).rejects.toMatchObject({
      name: "PdfKernelError",
      code: "unknown_component"
    });
    expect(fake.requests).toEqual([]);
  });

  it("takes a definition's own renditions and a plugin's from the runtime, and lets an explicit resolver win", async () => {
    const survey: ComponentNode = {
      id: "survey",
      type: "form",
      configuration: { title: "Survey" },
      children: {
        content: [
          { id: "stars", type: "rating", configuration: { label: "Stars" } },
          { id: "mood", type: "mood", configuration: { label: "Mood" } }
        ]
      }
    };
    const paragraphOf = (text: string) => (_node: unknown, context: unknown) => [
      { id: (context as { nextId(): string }).nextId(), kind: "paragraph" as const, runs: [{ text }] }
    ];
    const components = new ComponentRegistry();
    components.register({
      type: "rating",
      version: "1.0.0",
      createDefault: () => ({ id: "r", type: "rating", configuration: {} }),
      capabilities: [],
      pdf: { defaultRendition: "stars", renditions: [{ id: "stars", render: paragraphOf("★★★★") }] }
    });
    const plugins = new PdfRenditionRegistry();
    plugins.register({ componentType: "mood", rendition: { id: "emoji", render: paragraphOf(":-)") } });
    const paragraphs = (request: PdfKernelRequest | undefined) =>
      blocksOf(request).filter((block) => block.kind === "paragraph").map((block) => (block as { runs: Array<{ text: string }> }).runs[0]!.text);

    // Nothing wired by the host: the runtime's registries are consulted, and nothing is unknown.
    const fake = provider();
    const result = await renderFormPdf(
      runtime(undefined, { root: survey, renditionSources: { components, renditions: plugins } }),
      { provider: fake, environment },
      { unknownComponents: "fail" }
    );
    expect(paragraphs(fake.requests[0])).toEqual(["★★★★", ":-)"]);
    expect(result.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);

    // A resolver the host hands over is used as given, whatever the runtime holds.
    const bare = provider();
    const generic = await renderFormPdf(
      runtime(undefined, { root: survey, renditionSources: { components, renditions: plugins } }),
      { provider: bare, environment, renditions: createPdfRenditionResolver() }
    );
    expect(paragraphs(bare.requests[0])).toEqual([]);
    expect(generic.warnings.filter((warning) => warning.code === "component.unknown").map((warning) => warning.componentId)).toEqual(["stars", "mood"]);
  });

  it("renders in the locale asked for, leaves the form's own locale alone, and names the file for it", async () => {
    const fake = provider();
    const host = runtime(undefined, { root: bilingualRoot(), localization: BILINGUAL, translations: FRENCH });
    const french = await renderFormPdf(host, { provider: fake, environment }, { locale: "fr" });
    expect(french.fileName).toBe("intake-default-fr-20260905-101112.pdf");
    const request = fake.requests[0]!;
    expect(request.op).toBe("render");
    if (request.op === "render") {
      expect(request.document.metadata).toMatchObject({ title: "Admission", lang: "fr" });
    }
    const labels = blocksOf(request).flatMap((block) => (block.kind === "labelValue" ? [block.label] : []));
    expect(labels).toEqual(["Nom"]);
    // The live form was not switched.
    expect(host.state().locale).toBe("en");

    // The same runtime, asked for nothing in particular, renders in its own locale as before.
    const english = await renderFormPdf(host, { provider: fake, environment });
    expect(english.fileName).toBe("intake-default-20260905-101112.pdf");
    expect(blocksOf(fake.requests[1]).flatMap((block) => (block.kind === "labelValue" ? [block.label] : []))).toEqual(["Name"]);
  });

  it("refuses a locale the form does not declare, the way setLocale does, and accepts any when it declares none", async () => {
    const fake = provider();
    await expect(
      renderFormPdf(runtime(undefined, { root: bilingualRoot(), localization: BILINGUAL, translations: FRENCH }), { provider: fake, environment }, { locale: "de" })
    ).rejects.toThrow('Locale "de" is not supported');
    expect(fake.requests).toEqual([]);

    const undeclared = await renderFormPdf(runtime(undefined, { root: bilingualRoot(), translations: FRENCH }), { provider: fake, environment }, { locale: "fr" });
    expect(undeclared.fileName).toBe("intake-default-fr-20260905-101112.pdf");
    expect(blocksOf(fake.requests[0]).flatMap((block) => (block.kind === "labelValue" ? [block.label] : []))).toEqual(["Nom"]);
  });

  it("names the file safely, with the locale when one was asked for", () => {
    expect(pdfFileName("my form/v2", "copy for:applicant", "2026-01-02T03:04:05Z")).toBe("my_form_v2-copy_for_applicant-20260102-030405.pdf");
    expect(pdfFileName("intake", "record", "2026-01-02T03:04:05Z", "fr-CA")).toBe("intake-record-fr-CA-20260102-030405.pdf");
    expect(pdfFileName("intake", "record", "2026-01-02T03:04:05Z", "")).toBe("intake-record-20260102-030405.pdf");
  });

  it("resolvePdfImages leaves data resources alone", async () => {
    const document = {
      resources: { images: { a: { type: "image/png" as const, data: "AA==" }, b: { url: "x" } } }
    };
    const warnings = await resolvePdfImages(document as never, { resolve: async () => ({ type: "image/jpeg", data: "BB==" }) });
    expect(warnings).toEqual([]);
    expect(document.resources.images).toEqual({ a: { type: "image/png", data: "AA==" }, b: { type: "image/jpeg", data: "BB==" } });
  });
});

describe("renderFormPdf — PDF/A", () => {
  const profile = { storage: "asset", name: "org.icc", type: "application/vnd.iccprofile", size: 4, ref: "icc-1" };

  function claiming(pdfa?: string): ReturnType<typeof provider> {
    const fake = provider();
    fake.render = async (request) => {
      fake.requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", ...(pdfa ? { pdfa: pdfa as "2b" } : {}) };
    };
    fake.fill = async (request) => {
      fake.requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [], ...(pdfa ? { pdfa: pdfa as "2b" } : {}) };
    };
    return fake;
  }

  const generated: PdfGeneratedLayout = {
    id: "archive",
    kind: "generated",
    conformance: { pdfa: "2b", outputIntent: { profile, identifier: "Org RGB" } },
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "name" } }] } }
  };

  it("resolves the output intent's profile through the template resolver and sends the bytes", async () => {
    const fake = claiming("2b");
    const result = await renderFormPdf(
      runtime(),
      { provider: fake, environment, templates: { resolve: async (source) => (source.ref === "icc-1" ? new Uint8Array([1, 2, 3]) : new Uint8Array()) } },
      { layout: generated }
    );
    expect(result.pdfa).toBe("2b");
    expect(result.warnings).toEqual([]);
    const request = fake.requests[0]!;
    if (request.op === "render") {
      expect(request.document.conformance).toEqual({ pdfa: "2b", outputIntent: { profile: { data: "AQID" }, identifier: "Org RGB", info: "Org RGB" } });
    }
  });

  it("leaves a built-in profile to the kernel: nothing to resolve, no warning without a resolver", async () => {
    const fake = claiming("2b");
    const builtin: PdfGeneratedLayout = { ...generated, conformance: { pdfa: "2b", outputIntent: { profile: builtinProfileSource("gray") } } };
    const result = await renderFormPdf(runtime(), { provider: fake, environment }, { layout: builtin });
    expect(result.warnings).toEqual([]);
    const request = fake.requests[0]!;
    if (request.op === "render") {
      expect(request.document.conformance).toEqual({
        pdfa: "2b",
        outputIntent: { profile: { source: builtinProfileSource("gray") }, identifier: "Gray gamma 2.2", info: "Gray gamma 2.2, D65 white point" }
      });
    }
  });

  it("drops a profile the host cannot resolve, with a warning, and leaves the level in place", async () => {
    const fake = claiming("2b");
    const result = await renderFormPdf(
      runtime(),
      { provider: fake, environment, templates: { resolve: async () => { throw new Error("no such asset"); } } },
      { layout: generated }
    );
    expect(result.warnings).toEqual([expect.objectContaining({ code: "pdfa.outputIntent", message: expect.stringContaining("no such asset") })]);
    const request = fake.requests[0]!;
    if (request.op === "render") {
      expect(request.document.conformance).toEqual({ pdfa: "2b" });
    }
    // No resolver at all: only inline profiles resolve.
    const none = claiming("2b");
    const withoutResolver = await renderFormPdf(runtime(), { provider: none, environment }, { layout: generated });
    expect(withoutResolver.warnings.map((warning) => warning.code)).toEqual(["pdfa.outputIntent"]);
  });

  it("echoes the level a fill keeps from the template's PDF/A claim", async () => {
    const template: PdfConfiguration = {
      layouts: [{ id: "gov", kind: "template", template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" }, fields: [], conformance: { pdfa: "2b" } }]
    };
    const kept = await renderFormPdf(runtime(template), { provider: claiming("2b"), environment }, { layoutId: "gov" });
    expect(kept.warnings).toEqual([]);
    expect(kept.pdfa).toBe("2b");
  });

  it("applies the per-render override to a fill's conformance, both ways", async () => {
    const template: PdfConfiguration = {
      layouts: [{ id: "gov", kind: "template", template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" }, fields: [], conformance: { pdfa: "3b", attachData: true } }]
    };
    const forced = claiming("3u");
    await renderFormPdf(runtime(template), { provider: forced, environment }, { layoutId: "gov", render: { pdfa: "3u" } });
    const forcedRequest = forced.requests[0]!;
    if (forcedRequest.op === "fill") {
      // The level changes; what the layout attached stays.
      expect(forcedRequest.conformance).toMatchObject({ pdfa: "3u", attachments: [expect.objectContaining({ name: "submission.json" })] });
      expect(forcedRequest.options).toEqual({ flatten: false, readOnly: false, appearances: "regenerate" });
    }
    const off = claiming();
    const plain = await renderFormPdf(runtime(template), { provider: off, environment }, { layoutId: "gov", render: { pdfa: false } });
    expect(plain.warnings).toEqual([]);
    const offRequest = off.requests[0]!;
    if (offRequest.op === "fill") {
      expect(offRequest.conformance).toBeUndefined();
    }
  });
});

describe("renderFormPdf — attachments", () => {
  const photo = { storage: "base64", name: "photo.png", type: "image/png", size: 68, data: "iVBORw0KGgo=" };
  const hosted = { storage: "s3", name: "big.zip", type: "application/zip", size: 1024, ref: "u/1" };

  function filesRoot(): ComponentNode {
    return {
      id: "claim",
      type: "form",
      configuration: { title: "Claim" },
      children: {
        content: [
          { id: "doc", type: "file", configuration: { label: "Supporting document", storage: "base64", pdf: { attach: true } } },
          { id: "archive", type: "file", configuration: { label: "Archive", storage: "s3", pdf: { attach: true } } }
        ]
      }
    };
  }

  function filesRuntime(values: Record<string, unknown>, pdf?: PdfConfiguration): ReturnType<typeof runtime> {
    const base = runtime(pdf, { root: filesRoot() });
    const state = base.state();
    state.values = values;
    return base;
  }

  /** A provider that echoes the names it was sent, as a 3.5 program does; `echo: false` plays a 3.4 one. */
  function echoing(echo = true): ReturnType<typeof provider> {
    const fake = provider();
    const names = (attachments: Array<{ name: string }> | undefined) => (echo && attachments ? { attachments: attachments.map((entry) => entry.name) } : {});
    fake.render = async (request) => {
      fake.requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", ...names(request.document.attachments) };
    };
    fake.fill = async (request) => {
      fake.requests.push(request);
      return { bytes: PDF_MAGIC, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [], ...names(request.attachments) };
    };
    return fake;
  }

  const template: PdfConfiguration = {
    layouts: [{ id: "gov", kind: "template", template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" }, fields: [] }]
  };

  it("resolves a hosted upload through the template resolver and sends every file as bytes, echoing the names", async () => {
    const fake = echoing();
    const result = await renderFormPdf(
      filesRuntime({ doc: photo, archive: hosted }),
      { provider: fake, environment, templates: { resolve: async (source) => (source.ref === "u/1" ? new Uint8Array([1, 2, 3]) : new Uint8Array()) } }
    );
    expect(result.warnings).toEqual([]);
    expect(result.attachments).toEqual(["photo.png", "big.zip"]);
    const request = fake.requests[0]!;
    if (request.op === "render") {
      expect(request.document.attachments).toEqual([
        { name: "photo.png", mimeType: "image/png", description: "Supporting document", relationship: "Supplement", componentId: "doc", data: "iVBORw0KGgo=" },
        { name: "big.zip", mimeType: "application/zip", description: "Archive", relationship: "Supplement", componentId: "archive", data: "AQID" }
      ]);
    }
  });

  it("drops a hosted upload the host cannot resolve, naming the component, and keeps the rest", async () => {
    const fake = echoing();
    const result = await renderFormPdf(
      filesRuntime({ doc: photo, archive: hosted }),
      { provider: fake, environment, templates: { resolve: async () => { throw new Error("no such object"); } } }
    );
    expect(result.warnings).toEqual([{ code: "attachment.unresolved", componentId: "archive", message: expect.stringContaining("no such object") }]);
    expect(result.attachments).toEqual(["photo.png"]);
    // No resolver at all: only inline files travel.
    const none = await renderFormPdf(filesRuntime({ archive: hosted }), { provider: echoing(), environment });
    expect(none.warnings.map((warning) => warning.code)).toEqual(["attachment.unresolved"]);
    expect(none.attachments).toEqual([]);
  });

  it("sends a fill its uploaded files and reports the names embedded, and sends nothing with nothing to send", async () => {
    const fake = echoing();
    const filled = await renderFormPdf(filesRuntime({ doc: photo }, template), { provider: fake, environment }, { layoutId: "gov" });
    expect(filled.warnings).toEqual([]);
    expect(filled.attachments).toEqual(["photo.png"]);
    const request = fake.requests[0]!;
    if (request.op === "fill") {
      expect(request.attachments).toEqual([expect.objectContaining({ name: "photo.png", componentId: "doc" })]);
    }

    const quiet = await renderFormPdf(filesRuntime({}), { provider: echoing(false), environment });
    expect(quiet.warnings).toEqual([]);
    const quietRequest = (quiet as { document?: { attachments?: unknown } }).document;
    expect(quietRequest?.attachments).toBeUndefined();
  });

  it("applies the call's budget policy: skip with a warning, or refuse with the attachment_budget code", async () => {
    const skipped = await renderFormPdf(filesRuntime({ doc: photo }), { provider: echoing(), environment }, { attachments: { budgetBytes: 10 } });
    expect(skipped.warnings).toEqual([expect.objectContaining({ code: "attachment.skipped", componentId: "doc" })]);
    expect(skipped.attachments).toBeUndefined();

    await expect(
      renderFormPdf(filesRuntime({ doc: photo }), { provider: echoing(), environment }, { attachments: { budgetBytes: 10, onExceeded: "fail" } })
    ).rejects.toMatchObject({ name: "PdfKernelError", code: "attachment_budget" });
  });
});

describe("renderFormPdf — signatures", () => {
  const HANDOFF = { field: "Signature1", byteRange: [0, 10, 20, 5] as [number, number, number, number], digest: "ZGlnZXN0", toBeSigned: "dG8tYmUtc2lnbmVk", toBeSignedDigest: "dGJzLWRpZ2VzdA==", signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA256" as const, subFilter: "ETSI.CAdES.detached" as const };
  const PREPARED = new Uint8Array([1, 2, 3]);
  const SIGNED = new Uint8Array([4, 5, 6]);

  function signingProvider(options: { signing?: boolean; complete?: boolean; timestamp?: boolean } = {}) {
    const requests: PdfKernelRequest[] = [];
    const base: PdfRenderProvider & { requests: PdfKernelRequest[] } = {
      id: "fake",
      abiVersion: "1.0.0",
      requests,
      render: async (request) => {
        requests.push(request);
        return { bytes: PREPARED, pageCount: 1, pages: [], warnings: [], providerId: "fake", ...(options.signing === false || !request.signature ? {} : { signing: HANDOFF }) };
      },
      fill: async (request) => {
        requests.push(request);
        return { bytes: PREPARED, pageCount: 1, pages: [], warnings: [], providerId: "fake", fields: [], ...(options.signing === false || !request.signature ? {} : { signing: HANDOFF }) };
      }
    };
    if (options.complete !== false) {
      base.complete = async (request) => {
        requests.push(request);
        return { bytes: SIGNED, field: "Signature1", cms: "Y21z", timestamped: request.signing.timestamp !== undefined, providerId: "fake" };
      };
    }
    if (options.timestamp) {
      base.timestampRequest = async (request) => {
        requests.push(request);
        return new Uint8Array([9, 9]);
      };
    }
    return base;
  }

  const signer = { certificates: ["Y2VydA=="], calls: [] as Array<[Uint8Array, string]>, sign: async (toBeSigned: Uint8Array, algorithm: string) => { signer.calls.push([toBeSigned, algorithm]); return new Uint8Array([7, 7, 7]); } };

  it("passes the layout's settings and the signer's certificates to the provider, signs the handoff, completes, and publishes PDF_SIGNED", async () => {
    const fake = signingProvider();
    const layout: PdfGeneratedLayout = {
      id: "sealed",
      kind: "generated",
      signature: { field: "server-signature", certify: "noChanges", reason: "Submitted" },
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "sig", type: "pdf-signature", configuration: { fieldName: "server-signature" } }] } }
    };
    const events: unknown[] = [];
    const host = { ...runtime({ layouts: [layout] }), events: () => ({ publish: (event: unknown) => { events.push(event); }, subscribe: () => () => {} }) as never };
    signer.calls.length = 0;
    const result = await renderFormPdf(host, { provider: fake, environment }, { layoutId: "sealed", signature: { signer, settings: { location: "Ottawa" } } });
    expect(result.bytes).toBe(SIGNED);
    expect(result.signature).toEqual({ field: "Signature1", algorithm: "RSASSA-PKCS1-v1_5-SHA256", subFilter: "ETSI.CAdES.detached", certificates: ["Y2VydA=="], timestamped: false });
    expect(result.signing).toBeUndefined();
    const render = fake.requests[0]!;
    expect(render.op).toBe("render");
    if (render.op === "render") {
      expect(render.signature).toEqual({ field: "server-signature", certify: "noChanges", reason: "Submitted", location: "Ottawa", certificates: ["Y2VydA=="] });
      expect(render.document.signature).toEqual({ field: "server-signature", certify: "noChanges", reason: "Submitted" });
    }
    expect(signer.calls).toHaveLength(1);
    expect([...signer.calls[0]![0]]).toEqual([...Buffer.from("to-be-signed")]);
    expect(signer.calls[0]![1]).toBe("RSASSA-PKCS1-v1_5-SHA256");
    const complete = fake.requests[1]!;
    expect(complete.op).toBe("complete");
    if (complete.op === "complete") {
      expect(complete.pdf.data).toBe(Buffer.from(PREPARED).toString("base64"));
      expect(complete.signing).toEqual({ field: "server-signature", certify: "noChanges", reason: "Submitted", location: "Ottawa", certificates: ["Y2VydA=="], value: Buffer.from([7, 7, 7]).toString("base64"), toBeSignedDigest: "dGJzLWRpZ2VzdA==" });
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "PDF_SIGNED", source: "renderer", formId: "intake", data: { layoutId: "sealed", field: "Signature1", algorithm: "RSASSA-PKCS1-v1_5-SHA256", certification: "noChanges", certificateCount: 1, digest: "ZGlnZXN0", timestamped: false, byteLength: 3 } });
    expect(JSON.stringify(events[0])).not.toContain("dG8tYmUtc2lnbmVk");
  });

  it("fetches a timestamp through the timestamper when one is given", async () => {
    const fake = signingProvider({ timestamp: true });
    const layout: PdfGeneratedLayout = { id: "l", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } } };
    const timestamper = { requests: [] as Uint8Array[], timestamp: async (request: Uint8Array) => { timestamper.requests.push(request); return new Uint8Array([3, 1, 6, 1]); } };
    const result = await renderFormPdf(runtime({ layouts: [layout] }), { provider: fake, environment }, { layoutId: "l", signature: { signer, settings: { timestamp: true }, timestamper } });
    expect(result.signature?.timestamped).toBe(true);
    expect([...timestamper.requests[0]!]).toEqual([9, 9]);
    const complete = fake.requests.find((request) => request.op === "complete");
    expect(complete && complete.op === "complete" ? complete.signing.timestamp : undefined).toEqual({ token: Buffer.from([3, 1, 6, 1]).toString("base64") });
    expect(complete && complete.op === "complete" ? (complete.signing as { timestamp?: unknown; reserve?: unknown }) : {}).not.toHaveProperty("reserve");
  });

  it("signs a template fill the same way", async () => {
    const fake = signingProvider();
    const pdf: PdfConfiguration = {
      layouts: [{ id: "gov", kind: "template", template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" }, fields: [], signature: { field: "OfficerSignature" } }]
    };
    const result = await renderFormPdf(runtime(pdf), { provider: fake, environment }, { layoutId: "gov", signature: { signer } });
    expect(result.bytes).toBe(SIGNED);
    const fill = fake.requests[0]!;
    expect(fill.op === "fill" ? fill.signature : undefined).toEqual({ field: "OfficerSignature", certificates: ["Y2VydA=="] });
  });

  it("refuses rather than delivering unsigned: a provider that prepares nothing, or cannot complete", async () => {
    const layout: PdfGeneratedLayout = { id: "l", kind: "generated", root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [] } } };
    await expect(renderFormPdf(runtime({ layouts: [layout] }), { provider: signingProvider({ signing: false }), environment }, { layoutId: "l", signature: { signer } })).rejects.toMatchObject({ code: "signature" });
    await expect(renderFormPdf(runtime({ layouts: [layout] }), { provider: signingProvider({ complete: false }), environment }, { layoutId: "l", signature: { signer } })).rejects.toMatchObject({ code: "signature" });
    await expect(renderFormPdf(runtime({ layouts: [layout] }), { provider: signingProvider(), environment }, { layoutId: "l", signature: { signer, timestamper: { timestamp: async () => new Uint8Array() } } })).rejects.toMatchObject({ code: "signature" });
    // Without a signer nothing is asked of the provider: the layout's policy is the kernel's to enforce.
    const fake = signingProvider();
    const plain = await renderFormPdf(runtime({ layouts: [{ ...layout, signature: { certify: "noChanges" } }] }), { provider: fake, environment }, { layoutId: "l" });
    expect(plain.signature).toBeUndefined();
    expect(fake.requests[0]!.op === "render" ? fake.requests[0]!.signature : "x").toBeUndefined();
  });
});

describe("renderFormPdf — layouts chosen by the answers", () => {
  // `detail` shows only for Quebec, and leaves the submission when hidden (or is cleared):
  // its answer stays in the raw state after the person moves on, but not in what they submit.
  function conditionalForm(behaviour: "exclude-from-submission" | "clear"): FormDefinition {
    const layout = (id: string, when?: PdfGeneratedLayout["when"]): PdfGeneratedLayout => ({
      id,
      kind: "generated",
      ...(when ? { when } : {}),
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "t", type: "pdf-text", configuration: { text: id } }] } }
    });
    const quebec = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } } as const;
    return {
      id: "intake",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: { title: "Intake" },
        children: {
          content: [
            { id: "province", type: "text", configuration: { label: "Province" } },
            { id: "detail", type: "text", configuration: { label: "Détail", hiddenValueBehavior: behaviour }, rules: { visibleWhen: quebec } }
          ]
        }
      },
      pdf: {
        layouts: [
          layout("standard"),
          layout("quebec", { kind: "binary", operator: "eq", left: { kind: "path", path: "detail" }, right: { kind: "literal", value: "oui" } })
        ],
        defaultLayoutId: "standard"
      }
    };
  }

  function formRuntime(definition: FormDefinition): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  }

  it("follows setValue: the layout, the file name and layoutChoice change with the answers", async () => {
    const live = formRuntime(conditionalForm("exclude-from-submission"));
    const fake = provider();
    const before = await renderFormPdf(live, { provider: fake, environment });
    expect(before).toMatchObject({ layoutId: "standard", layoutChoice: "default", fileName: "intake-standard-20260905-101112.pdf" });

    live.setValue("province", "QC");
    live.setValue("detail", "oui");
    const after = await renderFormPdf(live, { provider: fake, environment });
    expect(after).toMatchObject({ layoutId: "quebec", layoutChoice: "condition", fileName: "intake-quebec-20260905-101112.pdf" });

    // An explicit id still wins.
    expect(await renderFormPdf(live, { provider: fake, environment }, { layoutId: "standard" })).toMatchObject({ layoutId: "standard", layoutChoice: "asked" });
  });

  it("reads the submittable answers, not the raw state: a hidden answer that leaves the submission chooses nothing", async () => {
    for (const behaviour of ["exclude-from-submission", "clear"] as const) {
      const live = formRuntime(conditionalForm(behaviour));
      live.setValue("province", "QC");
      live.setValue("detail", "oui");
      live.setValue("province", "ON");
      // The raw state still says "oui"; the submission would not carry it.
      expect(live.state().values.detail).toBe("oui");
      expect(live.submittableValues().detail).toBeUndefined();
      const result = await renderFormPdf(live, { provider: provider(), environment });
      expect(result).toMatchObject({ layoutId: "standard", layoutChoice: "default" });
    }
  });
});
