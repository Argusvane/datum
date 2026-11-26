import { describe, expect, it, vi } from "vitest";

import { DATUM_DARK_BUILDER_THEME, DEFAULT_PDF_THEME, PLAIN_PDF_THEME, type BuilderThemeDefinition, type FormPlugin, type PdfThemeDefinition } from "@argusvane/datum-engine";
import { builderThemes, createThemeRegistry, pdfThemes, themes } from "../src/themes.js";
import { createPluginPlatform, plugins } from "../src/plugins.js";

const SHELL: BuilderThemeDefinition = { id: "split-shell", version: "1.0.0", target: "builder", label: "Split shell", tokens: { "db-accent": "#6750a4" } };
const PAPER: PdfThemeDefinition = { id: "split-paper", version: "1.0.0", target: "pdf", label: "Split paper", pdf: { colors: { accent: "#0b3d91" } } };

describe("builderThemes and pdfThemes, the page's two theme registries", () => {
  it("start with the engine's own builder and PDF themes, each in its own registry", () => {
    const registry = createThemeRegistry();
    expect(registry.builder.list()).toEqual([DATUM_DARK_BUILDER_THEME]);
    expect(registry.pdf.list()).toEqual([DEFAULT_PDF_THEME, PLAIN_PDF_THEME]);
  });

  it("builder.register: a theme, a plugin's builderThemes, or a list; once each; the registry's reads see it", () => {
    const registry = createThemeRegistry();
    const seen: number[] = [];
    const stop = registry.subscribe(() => seen.push(registry.builderThemes().length));
    const plugin: Pick<FormPlugin, "builderThemes"> = { builderThemes: [{ ...SHELL, id: "split-shell-2" }] };
    expect(registry.builder.register(SHELL)).toBe(registry.builder);
    registry.builder.register([plugin, SHELL]);
    stop();
    expect(seen).toEqual([2, 3]);
    expect(registry.builderThemes().map((theme) => theme.id)).toEqual(["datum-dark", "split-shell", "split-shell-2"]);
    expect(registry.resolveBuilder("split-shell")).toBe(SHELL);
    expect(() => registry.builder.register({ ...SHELL, id: "wrong", target: "pdf" } as unknown as BuilderThemeDefinition)).toThrow(/"builder" themes only/);
  });

  it("pdf.register: a theme, a plugin's pdfThemes, or a list; resolvePdf, pdfOptions and pdfLookup see it", () => {
    const registry = createThemeRegistry();
    registry.pdf.register({ pdfThemes: [PAPER] }, { aliases: { paper: "split-paper" }, assetsBase: "https://cdn.example/paper/" });
    registry.pdf.register(PAPER);
    expect(registry.pdfThemes().map((theme) => theme.id)).toEqual(["datum-pdf", "datum-plain", "split-paper"]);
    expect(registry.pdfOptions().map((option) => option.id)).toEqual(["default", "datum-plain", "split-paper"]);
    expect(registry.resolvePdf("split-paper")).toBe(PAPER);
    expect(registry.resolvePdf("paper")).toBe(PAPER);
    expect(registry.pdfLookup("split-paper")).toBe(PAPER);
    expect(registry.assetsBase(PAPER)).toBe("https://cdn.example/paper/");
  });

  it("the page's builderThemes and pdfThemes are the shared registry's, and a plugin's slots reach them", () => {
    expect(builderThemes).toBe(themes.builder);
    expect(pdfThemes).toBe(themes.pdf);
    plugins.register({
      id: "split-themes-plugin",
      version: "1.0.0",
      builderThemes: [{ ...SHELL, id: "split-plugin-shell" }],
      pdfThemes: [{ ...PAPER, id: "split-plugin-paper" }]
    });
    expect(builderThemes.list().some((theme) => theme.id === "split-plugin-shell")).toBe(true);
    expect(pdfThemes.list().some((theme) => theme.id === "split-plugin-paper")).toBe(true);
    expect(themes.resolveBuilder("split-plugin-shell")?.id).toBe("split-plugin-shell");
    expect(themes.resolvePdf("split-plugin-paper").id).toBe("split-plugin-paper");
  });

  it("a per-runtime platform keeps a plugin whose builder or PDF theme extends a shipped theme", () => {
    const plugin: FormPlugin = {
      id: "split-extends-plugin",
      version: "1.0.0",
      builderThemes: [{ id: "split-dark-plus", version: "1.0.0", target: "builder", extends: "datum-dark", tokens: { "db-accent": "#ff0000" } }],
      pdfThemes: [{ id: "split-pdf-plus", version: "1.0.0", target: "pdf", extends: "datum-pdf", pdf: { colors: { accent: "#ff0000" } } }]
    };
    const result = createPluginPlatform([plugin]).installAndInitialize({ environment: "browser" });
    expect(result.failedPluginIds).toEqual([]);
    expect(result.installedPluginIds).toEqual(["split-extends-plugin"]);
    // The page's registry takes the same plugin, merged over the shipped base.
    const registry = createThemeRegistry();
    registry.pdf.register(plugin);
    registry.builder.register(plugin);
    expect(registry.resolvePdf("split-pdf-plus").target).toBe("pdf");
    expect(registry.resolveBuilder("split-dark-plus")?.id).toBe("split-dark-plus");
  });

  it("refuses a plugin whose builder or PDF theme has the wrong target, by name, and takes the plugins after it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    plugins.register({ id: "split-bad-target", version: "1.0.0", builderThemes: [{ ...SHELL, id: "split-bad-shell", target: "pdf" } as never] });
    plugins.register({ id: "split-bad-target-pdf", version: "1.0.0", pdfThemes: [{ ...PAPER, id: "split-bad-paper", target: "builder" } as never] });
    plugins.register({ id: "split-after-bad", version: "1.0.0", builderThemes: [{ ...SHELL, id: "split-good-shell" }] });
    const messages = error.mock.calls.map((call) => String(call[0]));
    error.mockRestore();
    expect(messages.some((line) => line.includes('"split-bad-target"') && line.includes('builderThemes[0].target must be "builder"'))).toBe(true);
    expect(messages.some((line) => line.includes('"split-bad-target-pdf"') && line.includes('pdfThemes[0].target must be "pdf"'))).toBe(true);
    expect(builderThemes.list().some((theme) => theme.id === "split-bad-shell")).toBe(false);
    expect(builderThemes.list().some((theme) => theme.id === "split-good-shell")).toBe(true);
  });

  it("reports a plugin theme with a missing base once and still forwards the plugins after it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      plugins.register({ id: "split-orphan", version: "1.0.0", builderThemes: [{ ...SHELL, id: "split-orphan-shell", extends: "split-missing-base" }] })
    ).not.toThrow();
    plugins.register({ id: "split-after-orphan", version: "1.0.0", builderThemes: [{ ...SHELL, id: "split-after-orphan-shell" }] });
    const messages = error.mock.calls.map((call) => String(call[0]));
    error.mockRestore();
    expect(messages.filter((line) => line.includes('"split-orphan"'))).toHaveLength(1);
    expect(builderThemes.list().some((theme) => theme.id === "split-after-orphan-shell")).toBe(true);
  });

  it("recognises a theme by id, version and target, tokens or not, and refuses input that is neither a theme nor a plugin with the slot", () => {
    const registry = createThemeRegistry();
    const tokenless = { id: "split-tokenless", version: "1.0.0", target: "pdf" as const, pdf: { colors: { accent: "#123456" } } } as unknown as PdfThemeDefinition;
    registry.pdf.register(tokenless);
    expect(registry.pdfThemes().map((theme) => theme.id)).toEqual(["datum-pdf", "datum-plain", "split-tokenless"]);
    // A plugin that names no PDF themes is said, not skipped.
    expect(() => registry.pdf.register({ themes: [], id: "x", version: "1.0.0" } as never)).toThrow(/pdfThemes\.register takes a theme/);
    expect(() => registry.builder.register({ nonsense: true } as never)).toThrow(/builderThemes\.register takes a theme/);
    // Refused before any of a list is taken up.
    expect(() => registry.builder.register([{ ...SHELL, id: "split-half" }, { nonsense: true }] as never)).toThrow();
    expect(registry.builder.engine.has("split-half")).toBe(false);
  });
});
