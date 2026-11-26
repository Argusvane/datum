import { describe, expect, it } from "vitest";

import { DATUM_DARK_BUILDER_THEME, DEFAULT_PDF_THEME, type BuilderThemeDefinition } from "@argusvane/datum-engine";
import { BUILDER_THEMES, PDF_THEME_OPTIONS, createThemeRegistry, themes } from "../src/themes.js";
import { plugins } from "../src/plugins.js";

import { ACME_BUILDER_THEME, ACME_PDF_THEME, BETA_PDF_THEME, acmeThemePlugin, betaThemePlugin } from "./fixtures/acme-theme.js";

describe("the theme registries (builder-shell and PDF themes)", () => {
  it("starts with the engine's own themes and nothing else", () => {
    const registry = createThemeRegistry();
    expect(registry.pdfOptions().map((option) => option.id)).toEqual(["default", "datum-plain"]);
    // The builder has one built-in look and registers its one dark palette as a theme.
    expect(registry.builderThemes()).toEqual([DATUM_DARK_BUILDER_THEME]);
    expect(registry.resolvePdf(undefined)).toBe(DEFAULT_PDF_THEME);
    expect(registry.resolveBuilder("default")).toBeUndefined();
    // An id nobody registered is loud, and says how to register it.
    expect(() => registry.resolvePdf("acme")).toThrow(/Unknown PDF theme "acme": register its package/);
    expect(() => registry.resolveBuilder("acme-shell")).toThrow(/Unknown builder theme "acme-shell"/);
  });

  it("keeps builder and PDF themes in their own registries", () => {
    expect(() => createThemeRegistry().pdf.register({ id: "x", version: "1", target: "builder" } as never)).toThrow(/"pdf" themes only/);
    expect(() => createThemeRegistry().builder.register({ id: "x", version: "1", target: "pdf" } as never)).toThrow(/"builder" themes only/);
  });

  it("treats a builder look id the registry never heard of like any other unknown id, and resolves a host's own under whatever id it chose", () => {
    const registry = createThemeRegistry();
    for (const id of ["datum-legacy", "legacy", "house-look", "house-look-dark"]) {
      expect(() => registry.resolveBuilder(id), id).toThrow(`Unknown builder theme "${id}"`);
    }
    const own: BuilderThemeDefinition = { id: "house-look", version: "1.0.0", target: "builder", label: "Our look", tokens: { "db-accent": "#6750a4" } };
    registry.builder.register(own);
    expect(registry.resolveBuilder("house-look")?.id).toBe("house-look");
    // The others are still unknown: registering one id made no other resolve.
    expect(() => registry.resolveBuilder("legacy")).toThrow(/Unknown builder theme "legacy"/);
    expect(registry.builderThemes().map((theme) => theme.id)).toEqual(["datum-dark", "house-look"]);
  });

  it("registers a plugin's themes, a lone theme, or a list, once each, and tells its listeners", () => {
    const registry = createThemeRegistry();
    const seen: number[] = [];
    const stop = registry.subscribe(() => seen.push(registry.pdfThemes().length));
    registry.pdf.register(acmeThemePlugin);
    registry.pdf.register([betaThemePlugin, { ...BETA_PDF_THEME, id: "gamma" }]);
    // A package registered again adds nothing: the list is as long as it was.
    registry.pdf.register(acmeThemePlugin);
    stop();
    registry.builder.register(acmeThemePlugin);
    expect(seen).toEqual([3, 5, 5]);
    expect(registry.pdfOptions().map((option) => option.id)).toEqual(["default", "datum-plain", "acme", "beta", "gamma"]);
    expect(registry.resolvePdf("acme")).toBe(ACME_PDF_THEME);
    expect(registry.resolvePdf("beta")).toBe(BETA_PDF_THEME);
    expect(registry.resolvePdf("acme").target).toBe("pdf");
    expect(registry.resolveBuilder("acme-shell")).toBe(ACME_BUILDER_THEME);
    // A layout's theme id resolves only to a PDF theme that is registered: nothing is derived.
    expect(registry.pdfLookup("acme")?.target).toBe("pdf");
    expect(registry.pdfLookup("nope")).toBeUndefined();
    expect(registry.pdfLookup("default")).toBe(DEFAULT_PDF_THEME);
  });

  it("names every theme in its picker by its label", () => {
    const registry = createThemeRegistry();
    registry.pdf.register(acmeThemePlugin);
    expect(registry.pdfOptions().map((option) => [option.id, option.label])).toEqual([
      ["default", "Datum (default)"],
      ["datum-plain", "Datum (plain)"],
      ["acme", "Acme Design System"]
    ]);
  });

  it("honours aliases and the assets base a registration names", () => {
    const registry = createThemeRegistry();
    registry.pdf.register(acmeThemePlugin, { aliases: { brand: "acme" }, assetsBase: "https://cdn.example/acme/" });
    expect(registry.resolvePdf("brand").id).toBe("acme");
    expect(registry.resolvePdf("acme").id).toBe("acme");
    expect(registry.assetsBase(registry.resolvePdf("brand"))).toBe("https://cdn.example/acme/");
    // No base named: the caller falls back to the bundle's own URL.
    registry.pdf.register(betaThemePlugin);
    expect(registry.assetsBase(BETA_PDF_THEME)).toBeUndefined();
  });

  it("is one object per page, shared across the bundles, with live lists over it", () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("datum.web-components.themes")]).toBe(themes);
    // Before any bundle: the engine's own themes, in the lists a page reads.
    expect(PDF_THEME_OPTIONS.map((option) => option.id)).toEqual(["default", "datum-plain"]);
    expect(BUILDER_THEMES).toEqual([DATUM_DARK_BUILDER_THEME]);
    themes.pdf.register([acmeThemePlugin, betaThemePlugin], { assetsBase: "https://cdn.example/datum/datum-themes.js" });
    expect(PDF_THEME_OPTIONS.map((option) => option.id)).toEqual(["default", "datum-plain", "acme", "beta"]);
    // A registration's assets base is the one it named.
    expect(themes.assetsBase(ACME_PDF_THEME)).toBe("https://cdn.example/datum/datum-themes.js");
    expect(themes.assetsBase(BETA_PDF_THEME)).toBe("https://cdn.example/datum/datum-themes.js");
  });

  it("takes up the themes a plugin carries, registered before or after", () => {
    plugins.register({ id: "gamma-themes", version: "1.0.0", builderThemes: [{ id: "gamma-shell", version: "1.0.0", target: "builder", label: "Gamma shell", tokens: {} }] });
    expect(themes.resolveBuilder("gamma-shell")?.id).toBe("gamma-shell");
    expect(BUILDER_THEMES.map((theme) => theme.id)).toContain("gamma-shell");
  });
});
