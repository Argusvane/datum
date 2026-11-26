import { describe, expect, it } from "vitest";

import { BuilderThemeRegistry, type BuilderThemeDefinition } from "../form-engine/builder/web-component/builder-theme-registry.js";
import { DATUM_DARK_BUILDER_THEME } from "../form-engine/builder/web-component/studio-dark-theme.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { PluginPlatform } from "../form-engine/plugins/platform/plugin-platform.js";
import { ComponentRegistry } from "../form-engine/registry/components/component-registry.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import { PluginRegistry } from "../form-engine/registry/plugins/plugin-registry.js";
import { ValidatorRegistry } from "../form-engine/registry/validators/validator-registry.js";
import { DEFAULT_PDF_THEME, PLAIN_PDF_THEME, type PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme-defaults.js";
import { PdfThemeRegistry, pdfThemeLookup } from "../form-engine/render/pdf/pdf-theme-registry.js";

const shell = (id: string, version: string, tokens: Record<string, string>, extra: Partial<BuilderThemeDefinition> = {}): BuilderThemeDefinition => ({
  id,
  version,
  target: "builder",
  tokens,
  ...extra
});

const paper = (id: string, version: string, extra: Partial<PdfThemeDefinition> = {}): PdfThemeDefinition => ({
  id,
  version,
  target: "pdf",
  ...extra
});

describe("BuilderThemeRegistry", () => {
  it("resolves the latest version of an id, or the version asked for", () => {
    const registry = new BuilderThemeRegistry();
    registry.register(shell("acme", "1.2.0", { "db-accent": "#222222" }));
    registry.register(shell("acme", "1.0.0", { "db-accent": "#111111" }));
    expect(registry.resolve("acme").tokens["db-accent"]).toBe("#222222");
    expect(registry.resolve("acme", "1.0.0").tokens["db-accent"]).toBe("#111111");
    expect(registry.has("acme")).toBe(true);
    expect(registry.has("acme", "1.0.0")).toBe(true);
    expect(registry.has("acme", "9.9.9")).toBe(false);
    expect(registry.has("nope")).toBe(false);
    expect(() => registry.resolve("nope")).toThrow(/No builder theme registered for id nope/);
    expect(() => registry.resolve("acme", "9.9.9")).toThrow(/version 9.9.9/);
  });

  it("refuses a second registration of the same id and version, and a theme of another target", () => {
    const registry = new BuilderThemeRegistry();
    registry.register(DATUM_DARK_BUILDER_THEME);
    expect(() => registry.register(DATUM_DARK_BUILDER_THEME)).toThrow(/already registered/);
    expect(() => registry.register({ ...DATUM_DARK_BUILDER_THEME, id: "x", target: "pdf" } as unknown as BuilderThemeDefinition)).toThrow(/"builder" themes only/);
  });

  it("merges a theme that extends another over its base, and refuses a missing base or itself", () => {
    const registry = new BuilderThemeRegistry();
    registry.register(shell("acme", "1.0.0", { "db-accent": "#111111", "db-surface": "#ffffff" }, { label: "Acme" }));
    registry.register(shell("acme-warm", "1.0.0", { "db-accent": "#aa5500" }, { extends: "acme" }));
    const merged = registry.resolve("acme-warm");
    expect(merged).toEqual({ id: "acme-warm", version: "1.0.0", target: "builder", label: "Acme", tokens: { "db-accent": "#aa5500", "db-surface": "#ffffff" } });
    expect("extends" in merged).toBe(false);
    expect(() => registry.register(shell("orphan", "1.0.0", {}, { extends: "missing" }))).toThrow(/register the base first/);
    expect(() => registry.register(shell("self", "1.0.0", {}, { extends: "self" }))).toThrow(/cannot extend itself/);
  });

  it("lists the latest of each id in the order the ids were first registered", () => {
    const registry = new BuilderThemeRegistry();
    registry.register(shell("b", "1.0.0", {}));
    registry.register(shell("a", "1.0.0", {}));
    registry.register(shell("b", "2.0.0", {}));
    expect(registry.list().map((theme) => `${theme.id}@${theme.version}`)).toEqual(["b@2.0.0", "a@1.0.0"]);
  });
});

describe("PdfThemeRegistry", () => {
  it("resolves by id alone, latest version first, and lists in registration order", () => {
    const registry = new PdfThemeRegistry();
    registry.register(DEFAULT_PDF_THEME);
    registry.register(PLAIN_PDF_THEME);
    registry.register(paper("datum-pdf", "9.0.0"));
    expect(registry.resolve("datum-pdf").version).toBe("9.0.0");
    expect(registry.resolve("datum-pdf", DEFAULT_PDF_THEME.version)).toBe(DEFAULT_PDF_THEME);
    expect(registry.list().map((theme) => theme.id)).toEqual(["datum-pdf", "datum-plain"]);
    expect(() => registry.resolve("nope")).toThrow(/No PDF theme registered for id nope/);
  });

  it("refuses duplicates and other targets", () => {
    const registry = new PdfThemeRegistry();
    registry.register(DEFAULT_PDF_THEME);
    expect(() => registry.register(DEFAULT_PDF_THEME)).toThrow(/already registered/);
    expect(() => registry.register({ ...DEFAULT_PDF_THEME, id: "x", target: "builder" } as unknown as PdfThemeDefinition)).toThrow(/"pdf" themes only/);
  });

  it("merges a theme that extends another: each field it sets, its whole pdf block included, over the base's", () => {
    const registry = new PdfThemeRegistry();
    registry.register(paper("corp", "1.0.0", { label: "Corp", pdf: { colors: { accent: "#123456" }, tagged: true } }));
    registry.register(paper("corp-wide", "1.0.0", { extends: "corp", pdf: { page: { size: "A4" } } }));
    expect(registry.resolve("corp-wide")).toEqual({ id: "corp-wide", version: "1.0.0", target: "pdf", label: "Corp", pdf: { page: { size: "A4" } } });
    expect(() => registry.register(paper("orphan", "1.0.0", { extends: "missing" }))).toThrow(/register the base first/);
  });

  it("is a source pdfThemeLookup reads", () => {
    const registry = new PdfThemeRegistry();
    registry.register(DEFAULT_PDF_THEME);
    const find = pdfThemeLookup(registry)!;
    expect(find("datum-pdf")).toBe(DEFAULT_PDF_THEME);
    expect(find("datum-plain")).toBeUndefined();
  });
});

describe("plugin builderThemes and pdfThemes slots", () => {
  function registries(withThemes: boolean) {
    return {
      plugins: new PluginRegistry(),
      components: new ComponentRegistry(),
      validators: new ValidatorRegistry(),
      dataSourceProviders: new DataSourceProviderRegistry(),
      dataSources: new DataSourceRegistry(),
      ...(withThemes ? { builderThemes: new BuilderThemeRegistry(), pdfThemes: new PdfThemeRegistry() } : {})
    };
  }

  it("lands each slot in its own registry", () => {
    const regs = registries(true);
    regs.plugins.register({
      id: "acme",
      version: "1.0.0",
      builderThemes: [shell("acme", "1.0.0", { "db-accent": "#0b3d91" })],
      pdfThemes: [paper("acme", "1.0.0", { pdf: { colors: { accent: "#0b3d91" } } })]
    });
    const result = new PluginPlatform(regs).installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).toEqual(["acme"]);
    expect(regs.builderThemes!.resolve("acme").tokens["db-accent"]).toBe("#0b3d91");
    expect(regs.pdfThemes!.resolve("acme").pdf?.colors?.accent).toBe("#0b3d91");
  });

  it("puts both registries back when the plugin fails part-way", () => {
    const regs = registries(true);
    regs.builderThemes!.register(shell("taken", "1.0.0", {}));
    // Both theme slots land first; the duplicate data source provider after them is what fails.
    const provider = { id: "countries", load: async () => ({ items: [] }) };
    regs.plugins.register({
      id: "broken",
      version: "1.0.0",
      pdfThemes: [paper("fresh", "1.0.0")],
      builderThemes: [shell("new", "1.0.0", {})],
      dataSourceProviders: [provider, provider]
    });
    const errors: unknown[] = [];
    const result = new PluginPlatform(regs, { onError: (error) => errors.push(error) }).installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(regs.builderThemes!.list().map((theme) => theme.id)).toEqual(["taken"]);
    expect(regs.pdfThemes!.list()).toEqual([]);
    expect(regs.pdfThemes!.has("fresh")).toBe(false);
  });

  it("leaves the slots untaken on a platform without the registries", () => {
    const regs = registries(false);
    regs.plugins.register({ id: "acme", version: "1.0.0", builderThemes: [shell("acme", "1.0.0", {})], pdfThemes: [paper("acme", "1.0.0")] });
    const result = new PluginPlatform(regs).installAndInitialize({ environment: "browser" });
    expect(result.installedPluginIds).toEqual(["acme"]);
  });
});
