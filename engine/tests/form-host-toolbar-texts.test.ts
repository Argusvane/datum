// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { readComponentPrintNote } from "../form-engine/render/core/print-options.js";
import { defineDatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import { extendBinding } from "../form-engine/render/live/contract.js";
import { registerBinding } from "../form-engine/render/live/binding-registry.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * The host toolbar's wording follows the form's locale: the markup is built
 * before any locale is known, so the labels are applied again when the runtime, the page's
 * texts or the locale change.
 */
afterEach(() => {
  document.body.innerHTML = "";
});

function runtime(): FormRuntime {
  const definition = {
    id: "f",
    version: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] } },
      children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
    }
  };
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition as never, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

describe("the form host's toolbar", () => {
  it("words its buttons and picker through the form texts and re-words them when the locale changes", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    host.texts = {
      validateLabel: { default: "Validate", locales: { fr: "Valider" } },
      printLabel: { default: "Print", locales: { fr: "Imprimer" } },
      pdfLabel: { default: "PDF", locales: { fr: "PDF (fr)" } },
      downloadPdfLabel: { default: "Download PDF", locales: { fr: "Télécharger le PDF" } },
      pdfLayoutLabel: { default: "PDF layout", locales: { fr: "Modèle de PDF" } }
    };
    const rt = runtime();
    host.runtime = rt;
    document.body.appendChild(host);
    const root = host.shadowRoot!;
    const validate = root.querySelector("[data-validate]")!;
    expect(validate.getAttribute("aria-label")).toBe("Validate");
    expect(root.querySelector('[part="validate-label"]')!.textContent).toBe("Validate");

    rt.setLocale("fr");
    expect(validate.getAttribute("aria-label")).toBe("Valider");
    expect(validate.getAttribute("title")).toBe("Valider");
    expect(root.querySelector('[part="validate-label"]')!.textContent).toBe("Valider");
    expect(root.querySelector('[part="print-label"]')!.textContent).toBe("Imprimer");
    expect(root.querySelector("[data-pdf]")!.getAttribute("aria-label")).toBe("Télécharger le PDF");
    expect(root.querySelector('[part="pdf-label"]')!.textContent).toBe("PDF (fr)");
    expect(root.querySelector("[data-pdf-layout]")!.getAttribute("aria-label")).toBe("Modèle de PDF");
  });
});

describe("the form host's binding", () => {
  it("forwards binding, assets and colorScheme to its renderer, before and after it is on the page", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    const assets = { stylesheets: [] } as never;
    host.binding = "acme";
    host.assets = assets;
    host.colorScheme = "dark";
    document.body.appendChild(host);
    const renderer = host.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
    expect(renderer.binding).toBe("acme");
    expect(renderer.assets).toBe(assets);
    expect(renderer.colorScheme).toBe("dark");
    host.binding = undefined;
    host.colorScheme = "light";
    expect(renderer.binding).toBeUndefined();
    expect(renderer.colorScheme).toBe("light");
  });

  it("forwards printTheme to its renderer, before and after it is on the page", () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    const theme = { id: "acme-print", label: "Acme", css: "", texts: {} } as never;
    host.printTheme = theme;
    document.body.appendChild(host);
    const renderer = host.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
    expect(renderer.printTheme).toBe(theme);
    expect(host.printTheme).toBe(theme);
    host.printTheme = undefined;
    expect(renderer.printTheme).toBeUndefined();
  });

  it("words the toolbar from the binding's language pack, by object or by registered id", () => {
    defineDatumFormHostElement();
    const pack = { texts: { fr: { validateLabel: "Valider (pack)" } } };
    const acme = extendBinding(createDatumBinding(), { id: "toolbar-pack", label: "Pack", ...pack });
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    const rt = runtime();
    rt.setLocale("fr");
    host.runtime = rt;
    document.body.appendChild(host);
    const label = () => host.shadowRoot!.querySelector('[part="validate-label"]')!.textContent;
    expect(label()).toBe("Validate");
    host.binding = acme;
    expect(label()).toBe("Valider (pack)");
    host.binding = undefined;
    expect(label()).toBe("Validate");
    host.binding = "toolbar-pack";
    expect(label()).toBe("Validate");
    registerBinding(acme);
    host.binding = "toolbar-pack";
    expect(label()).toBe("Valider (pack)");
  });
});

describe("the renderer's loading line and the print note", () => {
  it("words the loading line through the form texts", () => {
    defineDatumFormRendererElement();
    const el = document.createElement("datum-form-renderer") as HTMLElement & { texts?: unknown };
    el.texts = { loading: "Chargement du formulaire…" };
    document.body.appendChild(el);
    expect(el.shadowRoot!.querySelector("p")!.textContent).toBe("Chargement du formulaire…");
    const plain = document.createElement("datum-form-renderer");
    document.body.appendChild(plain);
    expect(plain.shadowRoot!.querySelector("p")!.textContent).toBe("Loading form…");
  });

  it("words a print note from the map and the catalog at its address", () => {
    const configuration = { print: { note: "Note" } };
    const translations = { fr: { components: { total: { print: { note: { text: "Remarque", source: "x" } } } } } };
    expect(readComponentPrintNote("total", configuration, "fr")).toBe("Note");
    expect(readComponentPrintNote("total", configuration, "fr", { translations })).toBe("Remarque");
    // Another component's entry is not this one's.
    expect(readComponentPrintNote("other", configuration, "fr", { translations })).toBe("Note");
    const catalog = { fr: { components: { total: { print: { note: "Remarque de l'hôte" } } } } };
    expect(readComponentPrintNote("total", configuration, "fr", { translations, catalog })).toBe("Remarque de l'hôte");
    expect(readComponentPrintNote("total", { print: { note: "  " } }, "fr")).toBeUndefined();
    expect(readComponentPrintNote("total", {}, "fr")).toBeUndefined();
  });
});
