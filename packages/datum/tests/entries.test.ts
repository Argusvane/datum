import { describe, expect, it } from "vitest";

describe("bundle entries", () => {
  it("the form entry defines <datum-form> only; the builder entry adds <datum-form-builder>", async () => {
    const form = await import("../src/form.js");
    expect(customElements.get("datum-form")).toBe(form.DatumFormElement);
    expect(customElements.get("datum-form-renderer")).toBeTruthy();
    expect(customElements.get("datum-form-builder")).toBeUndefined();
    expect(customElements.get("datum-builder")).toBeUndefined();

    const builder = await import("../src/builder.js");
    expect(customElements.get("datum-form-builder")).toBe(builder.DatumFormBuilderElement);
    expect(customElements.get("datum-builder")).toBeTruthy();
    // The builder entry is a superset of the form entry.
    expect(builder.DatumFormElement).toBe(form.DatumFormElement);
    expect(typeof builder.createFormRuntime).toBe("function");
    expect(typeof builder.resolveBuilderTheme).toBe("function");
  });

  it("the components and icons entries register on load and define no element", async () => {
    const { BUILTIN_ICONS, defaultIconSet, plugins } = await import("../src/builder.js");
    // The builder entry registers no icon library and no component library: the engine's own
    // drawings, and the standard catalogue, until a page loads the bundles that add them.
    expect(defaultIconSet()).toBe(BUILTIN_ICONS);
    expect(plugins.has("datum-acme-components")).toBe(false);

    const icons = await import("./fixtures/acme-icons-bundle.js");
    expect(defaultIconSet()).toBe(icons.ACME_ICONS);
    expect(icons.ACME_ICONS.id).toBe("acme-icons");

    const components = await import("./fixtures/acme-components-bundle.js");
    expect(plugins.has("datum-acme-components")).toBe(true);
    expect(components.plugins).toBe(plugins);
    expect(components.acmeComponentsPlugin.id).toBe("datum-acme-components");
    expect(plugins.components().map((definition) => definition.type)).toContain("acme-notice");
    expect(plugins.paletteEntries().every((entry) => entry.group === components.ACME_PALETTE_GROUP)).toBe(true);
    // Neither entry defines an element of its own.
    expect(customElements.get("datum-form")).toBe((await import("../src/form.js")).DatumFormElement);
  });

  it("a theme entry registers its package on load, assets resolved beside the bundle, and defines no element", async () => {
    const { themes } = await import("../src/form.js");
    expect(() => themes.resolvePdf("acme")).toThrow(/register its package/);
    const acme = await import("./fixtures/acme-theme-bundle.js");
    expect(themes.resolvePdf("acme").id).toBe("acme");
    expect(themes.resolveBuilder("acme-shell")?.id).toBe("acme-shell");
    expect(acme.themes).toBe(themes);
    expect(acme.acmeThemePlugin.id).toBeDefined();
    // The assets base is the bundle's own URL (here: the helper module the entries share).
    expect(themes.assetsBase(themes.resolvePdf("acme"))).toMatch(/acme-theme-bundle\.ts$/);

    // A second package's bundle registers into the same registry.
    const beta = await import("./fixtures/registry-beta-bundle.js");
    expect(themes.resolvePdf("beta").id).toBe("beta");
    expect(beta.themes).toBe(themes);
    expect(customElements.get("datum-form-builder")).toBeTruthy();
  });
});
