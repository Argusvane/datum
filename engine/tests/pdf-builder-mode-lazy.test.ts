// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";
import { createPdfBuilderMode, type PdfBuilderModeOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { PdfConfiguration, PdfGeneratedLayout, PdfTemplateSource } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";

/**
 * The PDF mode is a thin shell on the page: its designers, page viewer, Preview
 * dialog and Add popover are a chunk it loads on demand, and everything it says reads the builder's
 * locale and the host's `BuilderTextCatalog` (`textCatalog`), stored default names included.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake" },
  children: { content: [{ id: "province", type: "select", configuration: { label: "Province" } }] }
};

const FR: BuilderTextCatalog = {
  fr: {
    "pdf.bar.preview": "Aperçu PDF",
    "pdf.bar.suggest": "Suggérer les liaisons",
    "pdf.bar.preview.noExecutor": "Aucun moteur PDF",
    "pdf.badge.conditional": "Conditionnelle",
    "pdf.settings.label": "Mise en page",
    "pdf.copyName": "{name} (copie)",
    "pdf.newName.custom": "Mise en page personnalisée",
    "pdf.newName.blank": "Page blanche",
    "pdf.newName.paper": "Formulaire papier",
    "pdf.empty.title": "Aucune mise en page PDF",
    "pdf.add.label": "Ajouter une mise en page",
    "pdf.add.custom": "Mise en page personnalisée",
    "pdf.tryIt.derived": "PDF · tiré du formulaire",
    "pdf.order.label": "Quelle mise en page imprime",
    "pdfComponent.palette.text": "Texte",
    "languages.pdf.name": "Nom de la mise en page",
    "pdf.unusable.one": "{count} mise en page PDF inutilisable. {list}"
  }
};

function generated(id: string, name: string, when?: PdfGeneratedLayout["when"]): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    ...(when !== undefined ? { when } : {}),
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
  };
}

function mode(pdf: PdfConfiguration | undefined, options: Partial<PdfBuilderModeOptions> = {}, catalog: BuilderTextCatalog | undefined = FR) {
  return createPdfBuilderMode({
    formRoot: () => FORM,
    runtime: () => ({}) as RenderableRuntime,
    pdf,
    locale: () => "fr",
    textCatalog: () => catalog,
    ...options
  });
}

/** The mode's bar buttons and overlay elements, which a `BuilderMode` leaves optional. */
const bar = (m: ReturnType<typeof mode>): HTMLButtonElement[] => (m.barActions ?? []) as HTMLButtonElement[];
const overlay = (m: ReturnType<typeof mode>, index: number): HTMLElement => (m.overlays ?? [])[index]!;

/** A mode's context over a host of its own: the shell's host and shadow root, and where the canvas surface goes. */
function context(showCanvasSurface: (surface: HTMLElement | undefined) => void) {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: host.attachShadow({ mode: "open" }), showCanvasSurface, holdForInspector: (run: () => void) => (run(), true) };
}

const until = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

describe("the PDF mode's shell reads the builder's words", () => {
  it("words the bar, the badge, the settings label and the Try it card, English where the catalog says nothing", () => {
    const m = mode({ layouts: [generated("a", "A"), generated("b", "B", { kind: "always" } as never)] });
    const [suggest, , preview] = bar(m);
    expect(preview!.textContent).toBe("Aperçu PDF");
    expect(preview!.title).toBe("Aucun moteur PDF");
    expect(suggest!.textContent).toBe("Suggérer les liaisons");
    // Not in the catalog: the English.
    expect(bar(m)[1]!.textContent).toBe("Create form fields");
    expect(m.inspector!.settingsLabel).toBe("Mise en page");
    expect(m.documents!.list().map((entry) => entry.badge)).toContain("Conditionnelle");

    const english = mode({ layouts: [generated("a", "A")] }, { locale: () => "en" }, undefined);
    expect(bar(english)[2]!.textContent).toBe("Preview PDF");
    expect(english.inspector!.settingsLabel).toBe("Layout");
  });

  it("reads the catalog the shell assigns when the mode is added, as well as one given as an option", async () => {
    const added = createPdfBuilderMode({ formRoot: () => FORM, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [generated("a", "A")] }, locale: () => "fr" });
    expect(bar(added)[2]!.textContent).toBe("Preview PDF");
    added.textCatalog = () => FR;
    await added.activate!(context(() => undefined));
    expect(bar(added)[2]!.textContent).toBe("Aperçu PDF");
    expect(added.inspector!.settingsLabel).toBe("Mise en page");
  });

  it("words the rows it lends the Languages workspace in the builder's words when none are handed in", () => {
    const m = mode({ layouts: [generated("a", "A")] });
    expect(m.languageTexts().find((row) => row.label.includes("Nom de la mise en page"))).toBeDefined();
  });

  it("stores the names it makes in the builder's language: a copy, a populated form with no name", () => {
    const m = mode({ layouts: [generated("a", "Intake")] });
    const copy = m.duplicateLayout("a");
    expect(copy.name).toBe("Intake (copie)");
    const source: PdfTemplateSource = { storage: "base64", name: "f.pdf", type: "application/pdf", size: 1, data: "AA==" };
    expect(m.addTemplateLayout(source, "  ").name).toBe("Formulaire papier");
  });

  it("words the empty state, and the layouts an unusable seed left out", async () => {
    const errors: string[] = [];
    const m = mode({ layouts: [] }, { onError: (message) => errors.push(message) });
    let shown: HTMLElement | undefined;
    await m.activate!(context((surface) => (shown = surface)));
    expect(shown?.querySelector("h2")?.textContent).toBe("Aucune mise en page PDF");
    expect(shown?.querySelector("[data-pdf-empty-add]")?.textContent).toBe("New layout…");

    mode({ layouts: [generated("a", "A"), { id: "bad", kind: "template" } as never] }, { onError: (message) => errors.push(message) });
    expect(errors.some((message) => message.startsWith("1 mise en page PDF inutilisable."))).toBe(true);
  });

  it("brings the designer in when a layout is opened, and hands it the catalog: the palette is the builder's words", async () => {
    const m = mode({ layouts: [generated("a", "A")] });
    // Nothing of the designer is on the page before a layout is asked for.
    expect(m.designer).toBeUndefined();
    expect(m.ready).toBe(false);
    await m.activate!(context(() => undefined));
    await until(() => m.ready);
    expect(m.controller.componentTypes().find((entry) => entry.type === "pdf-text")?.label).toBe("Texte");
  });

  it("opens the Add popover once the chunk is in, worded in the builder's language", async () => {
    const m = mode({ layouts: [] });
    const host = document.createElement("div");
    host.append(...(m.overlays ?? []));
    document.body.append(host);
    expect(overlay(m, 1).querySelector("[data-add-custom]")).toBeNull();
    m.openAdd();
    await until(() => overlay(m, 1).querySelector('[data-add-custom="form"]'));
    expect(overlay(m, 1).getAttribute("aria-label")).toBe("Ajouter une mise en page");
    // A custom layout from the popover is offered a name in the builder's language, and made when the author accepts it.
    (overlay(m, 1).querySelector('[data-add-custom="blank"]') as HTMLButtonElement).click();
    expect(m.layouts).toEqual([]);
    expect((overlay(m, 1).querySelector("[data-add-name]") as HTMLInputElement).value).toBe("Page blanche");
    (overlay(m, 1).querySelector("[data-add-confirm]") as HTMLButtonElement).click();
    expect(m.layouts.map((layout) => layout.name)).toEqual(["Page blanche"]);
  });
});

describe("what stays on the page when the designer's chunk is not loaded", () => {
  const dir = join(import.meta.dirname, "..", "form-engine", "builder") + "/";
  /** Modules the shell's eager graph must not import by value: the chunk's (pdf-designer-chunk.ts), and the tables only it reads. */
  const lazy = [
    "pdf-designer/pdf-designer.js",
    "pdf-designer/pdf-template-designer.js",
    "pdf-designer/pdf-designer-panels.js",
    "pdf-designer/template-mode.js",
    "pdf-designer/template-pages.js",
    "pdf-designer/pdf-texts-en.js",
    "render/pdf/pdf-components.js",
    "render/pdf/pdf-template-components.js"
  ];
  const eager = [
    "pdf-designer/pdf-builder-mode.ts",
    "pdf-designer/layout-conditions.ts",
    "pdf-designer/layout-catalog.ts",
    "pdf-designer/pdf-mode-model.ts",
    "pdf-designer/pdf-layout-texts.ts",
    "pdf-designer/pdf-template-source.ts",
    "pdf-designer/pdf-panel-styles.ts",
    "pdf-designer/pdf-designer-loader.ts",
    "overview/overview-surface.ts"
  ];

  it("keeps the shell, the conditions, the catalog and the styles clear of the designer's modules", () => {
    for (const file of eager) {
      const text = readFileSync(dir + file, "utf8");
      for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        if (match[1] !== undefined) {
          continue;
        }
        const target = (match[2] as string).replace(/^(\.\.?\/)+/, "");
        for (const module of lazy) {
          expect(target.endsWith(module), `${file} imports ${module} by value; it belongs to the designer's chunk (pdf-designer-chunk.ts)`).toBe(false);
        }
      }
    }
  });

  it("reaches the designer through one dynamic import of the chunk's entry", () => {
    const loader = readFileSync(dir + "pdf-designer/pdf-designer-loader.ts", "utf8");
    expect(loader).toContain('import("./pdf-designer-chunk.js")');
    const chunk = readFileSync(dir + "pdf-designer/pdf-designer-chunk.ts", "utf8");
    for (const module of ["pdf-designer.js", "pdf-template-designer.js", "pdf-designer-panels.js", "template-mode.js", "template-pages.js"]) {
      expect(chunk).toContain(`./${module}`);
    }
  });
});

describe("the designer's chunk failing to load", () => {
  const CHUNK = "../form-engine/builder/pdf-designer/pdf-designer-chunk.js";

  afterEach(() => {
    vi.doUnmock(CHUNK);
    vi.resetModules();
  });

  async function failing() {
    vi.resetModules();
    vi.doMock(CHUNK, () => {
      throw new Error("chunk missing");
    });
    const fresh = await import("../form-engine/builder/pdf-designer/pdf-builder-mode.js");
    const errors: string[] = [];
    const m = fresh.createPdfBuilderMode({
      formRoot: () => FORM,
      runtime: () => ({}) as RenderableRuntime,
      pdf: { layouts: [generated("a", "A")] },
      locale: () => "en",
      onError: (message) => errors.push(message)
    });
    return { m, errors };
  }

  it("refuses the activation, shows the failed card with Retry on a later view, and loads on Retry", async () => {
    const { m, errors } = await failing();
    let shown: HTMLElement | undefined;
    await expect(m.activate!(context((surface) => (shown = surface)))).rejects.toThrow();
    expect(errors).toEqual(["The PDF designer could not load"]);

    await m.previewPdf();
    expect(shown?.querySelector("[data-pdf-retry]")?.textContent).toBe("Retry");
    expect(shown?.textContent).toContain("The layouts didn't load.");

    vi.doUnmock(CHUNK);
    const card = shown!;
    (card.querySelector("[data-pdf-retry]") as HTMLElement).click();
    await until(() => shown !== card);
    expect(m.designer).toBeDefined();
  });

  it("says a failed Preview and ends a superseded Add", async () => {
    const { m, errors } = await failing();
    await m.previewPdf();
    expect(errors).toContain("The layouts didn't load.");
    const ended: string[] = [];
    m.openAdd(undefined, { onEnd: (made) => ended.push(made ?? "none") });
    m.openAdd(undefined, { onEnd: (made) => ended.push(made ?? "none") });
    await until(() => ended.length === 2);
    expect(ended).toEqual(["none", "none"]);
  });
});
