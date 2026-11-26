import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuilderThemeDefinition } from "@argusvane/datum-engine";

import "../src/builder.js";
import { bindings } from "../src/builder.js";
// A fixture plugin that ships a builder theme and a PDF theme, registered as a page registers one.
import "./fixtures/acme-theme-bundle.js";
import { acmeComponentsPlugin } from "./fixtures/acme-components.js";
import { ACME_PDF_HEADING_COLOR } from "./fixtures/acme-theme.js";
import { themes } from "../src/themes.js";
import type { DatumFormBuilderChangeDetail, DatumFormBuilderElement, DatumFormBuilderModeChangeDetail } from "../src/builder.js";
import type { LiveBinding, PdfGeneratedLayout, PdfRenderProvider } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/**
 * A builder look a host registers itself: the package ships one built-in look, so
 * the seam is tested with a theme of the test's own. The 2px line shows the geometry tokens reach each element.
 */
const TEST_SHELL_THEME: BuilderThemeDefinition = {
  id: "test-shell",
  version: "1.0.0",
  target: "builder",
  label: "Test shell",
  tokens: { "db-accent": "#6b2fa3", "db-accent-ink": "#ffffff", "db-border-w": "2px" }
};
themes.builder.register(TEST_SHELL_THEME);

function designedLayout(): PdfGeneratedLayout {
  return {
    id: "letter",
    kind: "generated",
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: "name-field", type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
    }
  };
}

function fakeProvider(renders: unknown[]): PdfRenderProvider {
  return {
    id: "fake",
    abiVersion: "4.0.0",
    render: async (request: unknown) => {
      renders.push(request);
      return { bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
    }
  } as unknown as PdfRenderProvider;
}

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  setup?.(element);
  document.body.append(element);
  return element;
}

/** Waits for the inner builder to have mounted its panels. */
async function ready(element: DatumFormBuilderElement): Promise<void> {
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
}

function contentIds(element: DatumFormBuilderElement): string[] {
  return (element.definition.root.children?.content ?? []).map((node) => node.id);
}

describe("<datum-form-builder>", () => {
  it("defines the element and the engine's builder behind it", () => {
    expect(customElements.get("datum-form-builder")).toBeTruthy();
    expect(customElements.get("datum-builder")).toBeTruthy();
  });

  it("seeds the builder from the definition and reports edits as a FormDefinition", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    expect(contentIds(element)).toEqual(["fullName", "country", "subscribe", "email", "submit"]);
    expect(element.definition.localization).toEqual({
      defaultLocale: "en",
      supportedLocales: [
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français (Canada)" }
      ]
    });

    const changes: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) =>
      changes.push((event as CustomEvent<DatumFormBuilderChangeDetail>).detail)
    );
    element.controller!.add("text");
    await until(() => changes.length > 0);
    const reported = changes.at(-1)!;
    expect(reported.reason).not.toBe("preview");
    expect(reported.definition.id).toBe("sample-form");
    expect(reported.definition.version).toBe("2.0.0");
    expect(reported.definition.root.children?.content?.length).toBe(6);
    expect(reported.definition.root).toEqual(element.definition.root);
    expect(reported.selectedComponentId).toBe(reported.definition.root.children!.content!.at(-1)!.id);
  });

  it("hands the definition's identity to the builder's Form panel and reads the authored one back", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const builder = element.builder!;
    // Seeded from the definition, so the Identity section starts on its id and versions.
    expect(builder.identity).toEqual({ id: "sample-form", version: "2.0.0", schemaVersion: "1" });

    const reported: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) => {
      reported.push((event as CustomEvent<DatumFormBuilderChangeDetail>).detail);
    });
    // What the Form panel's Identity section commits on Save, through the same controller path.
    builder.controller.setIdentity({ id: "sample-form-v3", version: "3.0.0", schemaVersion: "1" });
    expect(element.definition.id).toBe("sample-form-v3");
    expect(element.definition.version).toBe("3.0.0");
    expect(element.definition.schemaVersion).toBe("1");
    // The rest of the definition rides along untouched.
    expect(element.definition.localization).toEqual(sampleDefinition().localization);
    expect(reported.at(-1)?.definition.id).toBe("sample-form-v3");
    expect(reported.at(-1)?.definition.version).toBe("3.0.0");
  });

  it("starts a new form when given no definition, under the default identity, holding the one Submit button", async () => {
    const element = mount();
    await ready(element);
    expect(element.definition).toMatchObject({ id: "form", version: "1.0.0", schemaVersion: "1" });
    expect(contentIds(element)).toEqual(["submit"]);
    expect(element.definition.localization).toBeUndefined();
  });

  it("takes the definition from the attribute, a bare form root included", async () => {
    const element = mount((el) => {
      el.setAttribute("definition", JSON.stringify(sampleDefinition().root));
    });
    await ready(element);
    expect(element.definition.id).toBe("form");
    expect(contentIds(element)).toEqual(["fullName", "country", "subscribe", "email", "submit"]);
  });

  it("forwards the layout to the inner builder", async () => {
    const element = mount((el) => {
      el.setAttribute("layout", "contained");
    });
    await ready(element);
    expect(element.layout).toBe("contained");
    expect(element.builder!.getAttribute("layout")).toBe("contained");
    expect(element.builder!.shadowRoot!.querySelector<HTMLElement>(".wrap")!.dataset.layout).toBe("contained");

    element.layout = "page";
    await until(() => element.builder!.getAttribute("layout") === null);
    expect(element.hasAttribute("layout")).toBe(false);
  });

  it("applies the shell theme without reseeding the tree", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    element.controller!.add("text");
    await until(() => contentIds(element).length === 6);

    element.setAttribute("theme", "test-shell");
    await until(() => (element.builder!.theme as { id: string } | undefined)?.id === "test-shell");
    // A theme is presentation: the edit made before it is still there.
    expect(contentIds(element).length).toBe(6);

    // The host's shell theme: its tokens, geometry and the ink on the accent included, reach the element.
    await until(() => element.builder!.style.getPropertyValue("--db-border-w") === "2px");
    expect(element.builder!.style.getPropertyValue("--db-accent")).toBe("#6b2fa3");
    expect(element.builder!.style.getPropertyValue("--db-accent-ink")).toBe("#ffffff");
    expect(contentIds(element).length).toBe(6);
    // A builder look no package registered (a retired one included: there is no alias for it) is
    // reported once as a datum-error and the built-in look stays, so a stale attribute cannot
    // break a builder.
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      element.setAttribute("theme", "retired-look");
      await until(() => element.builder!.theme === undefined);
      expect(element.builder!.style.getPropertyValue("--db-border-w")).toBe("");
      await until(() => errors.length === 1);
      expect(errors[0]).toContain('Unknown builder theme "retired-look"');
    } finally {
      logged.mockRestore();
    }
    expect(contentIds(element).length).toBe(6);
  });

  it("dresses every strip panel in the shell theme, the Header & footer and Variables panels included", async () => {
    const element = mount((el) => {
      el.setAttribute("theme", "test-shell");
    });
    await ready(element);
    await until(() => element.builder!.style.getPropertyValue("--db-border-w") === "2px");
    // Each panel declares the token defaults on its own host, so the theme has to reach each one.
    for (const tag of ["datum-builder-chrome-panel", "datum-builder-variables-panel"]) {
      const panel = element.builder!.shadowRoot!.querySelector<HTMLElement>(tag)!;
      expect(panel.style.getPropertyValue("--db-border-w"), tag).toBe("2px");
    }
  });

  it("restricts the palette with component-types", async () => {
    const element = mount((el) => {
      el.setAttribute("component-types", "text, select");
    });
    await ready(element);
    expect(element.controller!.componentTypes().map((entry) => entry.type)).toEqual(["text", "select"]);
  });

  it("drops types from the palette with a leading minus, whole groups with a prefix", async () => {
    // A component library's group is a plugin's: here the fixture one, registered on
    // the element, as a page registers it on `plugins`; the filter applies to its entries like any other.
    const element = mount((el) => {
      el.plugins = [acmeComponentsPlugin];
      el.setAttribute("component-types", "-acme-*, -grid");
    });
    await ready(element);
    const types = element.controller!.componentTypes().map((entry) => entry.type);
    expect(types).toContain("text");
    expect(types).toContain("tabs");
    expect(types).not.toContain("grid");
    expect(types.some((type) => type.startsWith("acme-"))).toBe(false);

    // Back to every type once the attribute goes; an exclusion beats an inclusion.
    element.removeAttribute("component-types");
    await ready(element);
    expect(element.controller!.componentTypes().some((entry) => entry.type === "acme-card")).toBe(true);
    element.setAttribute("component-types", "text, acme-card, -acme-*");
    await ready(element);
    expect(element.controller!.componentTypes().map((entry) => entry.type)).toEqual(["text"]);
  });

  it("hands the page's data sources to the canvas and the picker", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
      el.dataSourceIds = ["registered-elsewhere"];
      el.definition = sampleDefinition();
    });
    await ready(element);
    expect(element.controller!.dataSources()?.ids()).toEqual(["countries"]);
    expect(element.controller!.dataSourceIds()).toContain("registered-elsewhere");
  });

  it("hands the page's validation codes to the messages editor", async () => {
    const element = mount((el) => {
      el.setAttribute("validation-codes", "taken, delivery.failed");
      el.definition = sampleDefinition();
    });
    await ready(element);
    expect(element.controller!.validationCodes()).toEqual(["taken", "delivery.failed"]);
    // The form's own messages: the Form panel's subject is the root.
    const hostCodes = () =>
      element
        .controller!.inspectorModel(element.controller!.rootId())
        ?.sections.flatMap((section) => section.fields)
        .find((field) => field.control === "messages")?.messagesEditor?.hostCodes;
    expect(hostCodes()?.map((entry) => entry.code)).toEqual(["taken", "delivery.failed"]);
    // The property takes labelled entries too, for a hint on hover.
    element.validationCodes = [{ code: "taken", label: "Already registered." }];
    await until(() => hostCodes()?.length === 1);
    expect(hostCodes()).toEqual([{ code: "taken", label: "Already registered.", parameters: [] }]);
  });

  it("offers the canvas the form's own labelled locales and applies the locale attribute", async () => {
    const element = mount((el) => {
      el.setAttribute("locale", "fr-CA");
      el.definition = sampleDefinition();
    });
    await ready(element);
    // No page-supplied list: the switcher is the definition's `localization.supportedLocales`.
    expect(element.controller!.localeOptions()).toEqual([
      { code: "en", label: "English" },
      { code: "fr-CA", label: "Français (Canada)" }
    ]);
    expect(element.controller!.currentLocale()).toBe("fr-CA");
  });

  it("chains the toolbar-start, toolbar and canvas-actions slots through to the engine's builder", async () => {
    const element = mount();
    await ready(element);
    const inner = element.builder!;
    expect(inner.querySelector('slot[name="toolbar-start"][slot="toolbar-start"]')).toBeTruthy();
    expect(inner.querySelector('slot[name="toolbar"][slot="toolbar"]')).toBeTruthy();
    expect(inner.querySelector('slot[name="canvas-actions"][slot="canvas-actions"]')).toBeTruthy();
  });

  it("is the PDF builder too: a Form | PDF switch, the PDF side over the form's layouts, the definition carrying both", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    // The journeys are a side too, on by default and after the PDF one.
    await until(() => element.modes.length === 3);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    const inner = element.builder!;
    // The bar's label for the document on the page: its name, its kind, its badges.
    const label = () => {
      const face = inner.shadowRoot!.querySelector<HTMLElement>("[data-document-face]")!;
      return {
        name: face.querySelector("[data-document-picker-name]")!.textContent,
        kind: face.querySelector("[data-document-kind]")?.textContent,
        badges: [...face.querySelectorAll(".document-face-badge")].map((badge) => badge.textContent)
      };
    };
    expect(inner.shadowRoot!.querySelector<HTMLElement>("[data-documents]")!.hidden).toBe(false);
    // The form's label is the form's own title.
    expect(label()).toEqual({ name: "Sample", kind: "Form", badges: [] });
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);
    expect(element.mode).toBe("form");

    const changes: DatumFormBuilderChangeDetail[] = [];
    element.addEventListener("datum-builder-change", (event) => changes.push((event as CustomEvent<DatumFormBuilderChangeDetail>).detail));
    const modeChanges: DatumFormBuilderModeChangeDetail[] = [];
    element.addEventListener("datum-builder-mode-change", (event) => modeChanges.push((event as CustomEvent<DatumFormBuilderModeChangeDetail>).detail));

    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    expect(element.getAttribute("mode")).toBe("pdf");
    expect(modeChanges.at(-1)).toEqual({ mode: "pdf", previous: "form" });
    // The PDF side: the PDF palette on the panels, the layout's label on the bar, Preview PDF in the canvas's toolbar.
    expect(element.pdfMode!.controller.componentTypes().map((entry) => entry.type)).toContain("pdf-field");
    expect(inner.activeController).toBe(element.pdfMode!.controller);
    // "letter" is the PDF layout's name, the default's badge beside it.
    expect(label()).toEqual({ name: "letter", kind: "PDF layout", badges: ["Default"] });
    expect(inner.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-canvas-bar] [data-preview-pdf]")).toBeTruthy();
    // The PDF side's inspector offers no Rules tab: nothing reads a layout node's rules. It
    // draws only over a selection, so the layout's first node takes one.
    const propertiesRoot = (): ShadowRoot => inner.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;
    const selectFirstNode = (): void => {
      const controller = inner.activeController;
      const first = Object.values(controller.snapshot().children ?? {}).flat()[0];
      controller.select(first!.id);
    };
    selectFirstNode();
    expect(propertiesRoot().querySelector('[data-inspector-tab="rules"]')).toBeNull();
    expect(propertiesRoot().querySelector('[data-inspector-tab="properties"]')).toBeTruthy();

    // An edit on the PDF side reaches the definition and the change event, marked as the PDF side's.
    element.pdfMode!.newLayout({ name: "Back office", from: "blank" });
    await until(() => changes.some((change) => change.mode === "pdf" && change.reason === "layouts"));
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter", "back-office"]);
    expect(changes.at(-1)!.definition.pdf?.layouts?.length).toBe(2);
    // The new layout is the one on the page, named on the bar.
    await until(() => label().name === "Back office");
    expect(label()).toEqual({ name: "Back office", kind: "PDF layout", badges: [] });
    // The form side is untouched, and still what `controller` and the form's events are about.
    expect(element.definition.root.children?.content?.length).toBe(5);
    expect(element.controller!.componentTypes().map((entry) => entry.type)).toContain("text");

    element.mode = "form";
    await until(() => element.mode === "form");
    expect(inner.activeController).toBe(element.controller);
    expect(inner.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!.querySelector("[data-preview-pdf]")).toBeNull();
    selectFirstNode();
    expect(propertiesRoot().querySelector('[data-inspector-tab="rules"]')).toBeTruthy();
  });

  it("authors a layout's own text in the form's locales, following the list the form commits, without the form-level controls", async () => {
    const element = mount((el) => {
      el.definition = { ...sampleDefinition(), pdf: { layouts: [designedLayout()], defaultLayoutId: "letter" } };
    });
    await ready(element);
    await until(() => element.modes.length === 3);
    const inner = element.builder!;
    // A layout's document is the Form panel's subject, as the form's root is.
    const propertiesRoot = (): ShadowRoot => {
      const panel = inner.shadowRoot!.querySelector("datum-builder-form-panel") as HTMLElement;
  // A panel behind its strip item is not on screen and does not paint, so it is opened the
  // way an author opens it. Harmless when it is already open.
      if (panel.hidden) {
        inner.shadowRoot!.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
      }
      return panel.shadowRoot!;
    };
    const switcherLocales = (): unknown[] =>
      (inner.shadowRoot!.querySelector("[data-locale-select]") as unknown as { locales: unknown[] }).locales;

    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    const pdf = element.pdfMode!.controller;
    // The layout's controller declares the form's locales: the document's "Layout name" is a plain
    // string in the form's language, and its translations are rows of the Languages workspace.
    expect(pdf.localization()).toEqual(sampleDefinition().localization);
    expect(propertiesRoot().querySelector("[data-translations-edit]")).toBeNull();
    // The list itself is the definition's, edited on the Form side: no section, no switcher here.
    expect(propertiesRoot().querySelector('[data-inspector-section="localization"]')).toBeNull();
    expect(switcherLocales()).toEqual([]);
    // A name authored on the layout lands in the layout, not in the definition's localization.
    pdf.setDraftProperty("document", "name", "Client copy");
    pdf.commitDraft("document");
    await until(() => element.definition.pdf?.layouts?.[0]?.name !== undefined);
    expect(element.definition.pdf?.layouts?.[0]?.name).toBe("Client copy");
    expect(element.definition.localization).toEqual(sampleDefinition().localization);

    // A locale the form gains is offered on the next visit to the PDF side.
    element.mode = "form";
    await until(() => element.mode === "form");
    element.controller!.setLocalization({
      defaultLocale: "en",
      supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français (Canada)" }, { code: "es", label: "Español" }]
    });
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    await until(() => pdf.localeOptions().length === 3);
    expect(pdf.localeOptions().map((entry) => entry.code)).toEqual(["en", "fr-CA", "es"]);
    expect(switcherLocales()).toEqual([]);
  });

  it('hides the PDF side for pdf="off", and previews through an executor the page built', async () => {
    const element = mount((el) => {
      el.setAttribute("pdf", "off");
      el.definition = sampleDefinition();
    });
    await ready(element);
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "journeys"]);
    expect(element.pdfMode).toBeUndefined();
    expect(element.definition.pdf).toBeUndefined();

    element.removeAttribute("pdf");
    await until(() => element.modes.length === 3);
    // The PDF side comes back ahead of the journeys, as it is listed when on from the start.
    expect(element.modes.map((mode) => mode.id)).toEqual(["form", "pdf", "journeys"]);
    const renders: unknown[] = [];
    element.pdfSupport = { provider: fakeProvider(renders) };
    element.values = { fullName: "Grace Hopper" };
    element.mode = "pdf";
    // A form declaring no layouts gets none: the PDF overview says so, and
    // the definition reads back without a pdf block.
    const canvasRoot = (): ShadowRoot => element.builder!.shadowRoot!.querySelector("datum-builder-canvas")!.shadowRoot!;
    await until(() => element.builder!.shadowRoot!.querySelector("datum-builder-overview")?.shadowRoot?.querySelector("[data-overview-pdf-none]"));
    expect(element.builder!.workspace).toBe("pdf");
    expect(element.pdfMode!.layouts).toEqual([]);
    expect(element.definition.pdf).toBeUndefined();
    // Preview prints what a host would: the layout derived from the form.
    const result = await element.pdfMode!.renderPdf();
    expect(result.layoutId).toBe("default");
    expect(result.themeId).toBe("datum-pdf");
    expect(renders.length).toBe(1);
    expect(JSON.stringify(renders[0])).toContain("Grace Hopper");

    // A layout from the form is the author's own, written into the definition.
    element.pdfMode!.newLayout({ name: "Letter", from: "form" });
    element.mode = "pdf";
    await until(() => element.builder!.mode === "pdf" && element.pdfMode?.ready);
    expect(element.definition.pdf?.layouts?.map((layout) => layout.id)).toEqual(["letter"]);
    expect(canvasRoot().querySelector("[data-canvas-surface] [data-pdf-empty]")).toBeNull();

    // The PDF side offers the package's themes on the document's properties, and pdf-theme
    // sets the default the previews render under: the registered theme's headings reach the kernel.
    const documentDefinition = element.pdfMode!.designer?.builderOptions.componentDefinitions?.find((definition) => definition.type === "pdf-document");
    const themeField = documentDefinition?.propertyEditor?.fields?.find((field) => field.id === "theme");
    expect(themeField?.type).toBe("select");
    expect(themeField?.choices?.map((choice) => choice.value)).toEqual(["", "default", "datum-plain", "acme"]);
    element.setAttribute("pdf-theme", "acme");
    await until(() => element.pdfTheme === "acme");
    const themed = await element.pdfMode!.renderPdf();
    expect(themed.themeId).toBe("acme");
    expect(JSON.stringify(renders[1])).toContain(ACME_PDF_HEADING_COLOR);

    element.setAttribute("pdf", "off");
    await until(() => element.modes.length === 2);
    expect(element.mode).toBe("form");
    expect(element.pdfMode).toBeUndefined();
  });

  it("previews a PDF under the PDF theme the canvas binding suggests, as <datum-form> prints, until pdf-theme names one", async () => {
    const suggesting: LiveBinding = { id: "wc-builder-pdf-suggests", label: "Suggests", components: {}, pdfTheme: "acme" };
    bindings.register(suggesting);
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(element);
    const renders: unknown[] = [];
    element.pdfSupport = { provider: fakeProvider(renders) };
    element.mode = "pdf";
    await until(() => element.builder!.shadowRoot!.querySelector("datum-builder-overview")?.shadowRoot?.querySelector("[data-overview-pdf-none]"));
    // Datum's binding suggests nothing: the engine's own look.
    expect((await element.pdfMode!.renderPdf()).themeId).toBe("datum-pdf");
    // A binding picked after the mode was built counts on the next preview.
    element.binding = suggesting;
    await until(() => element.controller!.bindingId() === suggesting.id);
    const suggested = await element.pdfMode!.renderPdf();
    expect(suggested.themeId).toBe("acme");
    expect(JSON.stringify(renders.at(-1))).toContain(ACME_PDF_HEADING_COLOR);
    // The host's default is the rung above the binding's.
    element.setAttribute("pdf-theme", "datum-plain");
    await until(() => element.pdfTheme === "datum-plain");
    expect((await element.pdfMode!.renderPdf()).themeId).toBe("datum-plain");
  });

  it("walks and marks a host's own strip items as it does its own: the arrows reach them, the open one shows selected", async () => {
    const element = mount();
    await ready(element);
    const inner = element.builder!;
    const shellItems = (): HTMLElement[] => [...inner.shadowRoot!.querySelectorAll<HTMLElement>("[data-strip] [data-panel]:not([hidden]):not([data-out-of-workspace])")];
    const deepActive = (): Element | null => {
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const press = (key: string): void => {
      deepActive()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
    };
    // A host's item and its panel, wired as a host page wires its own, but
    // with no aria-selected of its own: whatever it shows is the shell's doing. A hidden item
    // ahead of it is one the keyboard passes over.
    const skipped = document.createElement("button");
    skipped.type = "button";
    skipped.slot = "strip";
    skipped.dataset.panel = "host-elsewhere";
    skipped.hidden = true;
    const item = document.createElement("button");
    item.type = "button";
    item.slot = "strip";
    item.setAttribute("role", "tab");
    item.dataset.panel = "host-sources";
    item.textContent = "Sources";
    const panel = document.createElement("section");
    panel.slot = "panel";
    panel.dataset.panel = "host-sources";
    panel.hidden = true;
    inner.append(skipped, item, panel);
    await until(() => inner.shadowRoot!.querySelector<HTMLSlotElement>('[data-strip] slot[name="strip"]')!.assignedElements({ flatten: true }).length === 2);

    // Down from the shell's last item reaches the host's, past the hidden one, and Up comes
    // back; Down from the host's, the strip's last, wraps round to the shell's first.
    const last = shellItems()[shellItems().length - 1]!;
    last.focus();
    expect(deepActive()).toBe(last);
    press("ArrowDown");
    expect(deepActive()).toBe(item);
    press("ArrowUp");
    expect(deepActive()).toBe(last);
    item.focus();
    press("ArrowDown");
    expect(deepActive()).toBe(shellItems()[0]);

    // Clicking it opens its panel and marks it, and it alone, selected.
    item.click();
    expect(inner.panel).toBe("host-sources");
    expect(panel.hidden).toBe(false);
    expect(item.getAttribute("aria-selected")).toBe("true");
    for (const shell of inner.shadowRoot!.querySelectorAll<HTMLElement>("[data-strip] [role=tab]")) {
      expect(shell.getAttribute("aria-selected")).toBe("false");
    }
    expect(skipped.getAttribute("aria-selected")).toBe("false");

    // A shell panel opening takes the mark back off it.
    const outline = inner.shadowRoot!.querySelector<HTMLElement>('[data-strip] [data-panel="outline"]')!;
    outline.click();
    expect(inner.panel).toBe("outline");
    expect(panel.hidden).toBe(true);
    expect(item.getAttribute("aria-selected")).toBe("false");
    expect(outline.getAttribute("aria-selected")).toBe("true");
  });
});

describe("<datum-form-builder load-fonts>", () => {
  afterEach(() => {
    document.head.querySelectorAll("link[data-datum-builder-font]").forEach((link) => link.remove());
  });

  it("links the builder's own faces once, and nothing else: the canvas form takes its sheets from a binding's assets", async () => {
    const faces = () => document.head.querySelectorAll('link[data-datum-builder-font$="/builder-fonts/builder-fonts.css"]');
    const all = () => document.head.querySelectorAll("link[data-datum-builder-font]");
    const plain = mount((el) => {
      el.definition = sampleDefinition();
    });
    await ready(plain);
    expect(all()).toHaveLength(0);

    const linked = mount((el) => {
      el.setAttribute("load-fonts", "");
      el.definition = sampleDefinition();
    });
    await ready(linked);
    await until(() => faces().length === 1);
    await ready(linked);
    expect(all()).toHaveLength(1);
    expect(faces()).toHaveLength(1);
  });
});

describe("the Form settings panel paint contract and heading", () => {
  it("typing the form's title writes a live draft: the panel and the canvas do not repaint, the box and focus stay, the footer updates in place, blur commits plainly", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const shadow = element.builder!.shadowRoot!;
    shadow.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const formPanel = shadow.querySelector("datum-builder-form-panel")!;
    const canvas = shadow.querySelector("datum-builder-canvas")!;
    const root = formPanel.shadowRoot!;
    expect(root.querySelector("h2")?.textContent).toContain("Form");
    const box = root.querySelector<HTMLInputElement>('input[data-prop="title"]')!;
    const protos = [formPanel, canvas].map((el) => Object.getPrototypeOf(el) as { render(): void });
    const originals = protos.map((proto) => proto.render);
    const counts = [0, 0];
    protos.forEach((proto, index) => {
      const original = proto.render;
      proto.render = function (this: unknown) {
        counts[index]!++;
        return original.call(this);
      };
    });
    try {
      box.focus();
      for (const text of ["A", "Ab", "Abc", "Abcd"]) {
        box.value = text;
        box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      expect(counts).toEqual([0, 0]);
      expect(root.querySelector('input[data-prop="title"]')).toBe(box);
      expect(root.activeElement).toBe(box);
      expect(box.value).toBe("Abcd");
      expect(root.querySelector("[data-not-applied]")).toBeTruthy();
      expect(root.querySelector("[data-inspector-save]")!.hasAttribute("disabled")).toBe(false);
    } finally {
      protos.forEach((proto, index) => {
        proto.render = originals[index]!;
      });
    }
    box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(element.builder!.activeController.draftProperty("root", "title")).toBe("Abcd");
  });

  it("a keystroke costs no footer redraw once the pending flag is set, and a focusout after Save writes nothing more", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const shadow = element.builder!.shadowRoot!;
    shadow.querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const formPanel = shadow.querySelector("datum-builder-form-panel")!;
    const root = formPanel.shadowRoot!;
    const controller = element.builder!.activeController;
    const box = root.querySelector<HTMLInputElement>('input[data-prop="title"]')!;
    const type = (text: string): void => {
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    };
    box.focus();
    type("A");
    const footer = root.querySelector(".inspector-footer");
    expect(footer).toBeTruthy();
    type("Ab");
    type("Abc");
    // The same footer node: it is redrawn when the flag moves, not on every keystroke.
    expect(root.querySelector(".inspector-footer")).toBe(footer);
    const reasons: string[] = [];
    controller.on("change", (event) => reasons.push(`${event.reason}${event.live ? ":live" : ""}`));
    root.querySelector<HTMLElement>("[data-inspector-save]")!.click();
    expect(reasons).toEqual(["edit"]);
    // The repaint after Save moved focus off the old box; its focusout must not write a second plain change.
    box.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(reasons).toEqual(["edit"]);
  });

  it("the Components palette and the Outline carry a real heading", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = sampleDefinition();
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const shadow = element.builder!.shadowRoot!;
    shadow.querySelector<HTMLElement>('[data-strip] [data-panel="outline"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shadow.querySelector(".outline")!.shadowRoot!.querySelector("h2")?.textContent).toBe("Outline");
    expect(shadow.querySelector(".toolbar")!.shadowRoot!.querySelector("h2")?.textContent).toBe("Components");
  });
});
