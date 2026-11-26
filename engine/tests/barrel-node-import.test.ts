import { describe, expect, it } from "vitest";

/**
 * The engine is isomorphic (`runtime/server`, `validation/server`, `data/server`, and
 * plugins declaring `environments: ["browser", "server"]`), so its public barrels must stay
 * importable with no DOM. This suite runs under vitest's default `node` environment, where
 * a bare `class X extends HTMLElement` in any re-exported module throws at import time —
 * which is exactly how the render barrel regressed once (caught only by a downstream
 * package's tests, since no engine test imported the barrels).
 */
describe("public barrels under Node (no DOM)", () => {
  it("has no DOM globals in this environment", () => {
    expect(typeof HTMLElement).toBe("undefined");
    expect(typeof customElements).toBe("undefined");
  });

  it("imports the render barrel, custom-element classes included", async () => {
    const render = await import("../form-engine/render/index.js");
    expect(typeof render.buildThemeStyleVars).toBe("function");
    // The classes still evaluate — they just extend an inert DOM-less base.
    expect(typeof render.DatumFormRendererElement).toBe("function");
    expect(typeof render.DatumLocaleSelectElement).toBe("function");
    expect(typeof render.DatumFormHostElement).toBe("function");
    // The print model and document builders are pure; the frame module beside them reaches the
    // DOM only inside its functions, so the element that imports it still evaluates here.
    expect(typeof render.buildPrintModel).toBe("function");
    expect(typeof render.buildPrintDocument).toBe("function");
    expect(typeof render.printHtml).toBe("function");
    expect(typeof render.basicPrintTheme.css).toBe("string");
    expect(typeof render.presentPrintDocument).toBe("function");
    expect(render.PRINT_TRUSTED_TYPES_POLICY).toBe("datum-print");
    expect(render.ASSETS_TRUSTED_TYPES_POLICY).toBe("datum-assets");
    // Same footing: the download helper reaches the DOM only when called.
    expect(typeof render.downloadSubmission).toBe("function");
    // The PDF pipeline is pure engine code plus a DOM-free provider seam.
    expect(typeof render.buildPdfRenderModel).toBe("function");
    expect(typeof render.renderFormPdf).toBe("function");
    expect(typeof render.registerPdfRenderMode).toBe("function");
    expect(typeof render.registerRenderModeAdapter).toBe("function");
    expect(typeof render.downloadPdf).toBe("function");
    expect(typeof render.PDF_ABI_VERSION).toBe("string");
  });

  it("imports the builder and root barrels", async () => {
    const builder = await import("../form-engine/builder/index.js");
    expect(typeof builder.BuilderController).toBe("function");

    const root = await import("../form-engine/index.js");
    expect(typeof root.FormRuntime).toBe("function");
  });

  it("imports the agent subpath barrel, which the root barrel never re-exports", async () => {
    const agent = await import("../form-engine/agent/index.js");
    expect(typeof agent.createAgentRegistrar).toBe("function");
    expect(typeof agent.createFormAgentTools).toBe("function");
    // The builder catalogue and its bare-controller host load under plain node too.
    expect(typeof agent.createBuilderTools).toBe("function");
    expect(typeof agent.createControllerHost).toBe("function");

    const root = await import("../form-engine/index.js");
    expect((root as Record<string, unknown>).createAgentRegistrar).toBeUndefined();
    expect((root as Record<string, unknown>).createFormAgentTools).toBeUndefined();
  });

  it("no-ops element registration instead of throwing when there is no registry", async () => {
    const { defineDatumFormHostElement, defineDatumLocaleSelectElement, defineDatumFormRendererElement } =
      await import("../form-engine/render/index.js");
    expect(() => defineDatumLocaleSelectElement()).not.toThrow();
    expect(() => defineDatumFormRendererElement()).not.toThrow();
    expect(() => defineDatumFormHostElement()).not.toThrow();

    const { defineDatumBuilderElement } = await import("../form-engine/builder/index.js");
    expect(() => defineDatumBuilderElement()).not.toThrow();
  });
});
