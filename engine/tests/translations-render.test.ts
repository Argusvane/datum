// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { FormDefinition } from "../form-engine/core/schema/types.js";
import type { TranslationCatalog } from "../form-engine/core/schema/contracts.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import {
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * At the renderer element every text the form shows is worded from the definition's
 * `translations` map and the host's catalog, by the text's address, and switching the locale
 * re-words what is on the page — a shown error included. The canonical form is the fixture the
 * schema's own tests read (`customer-intake.translations.json`): strings in English, French for
 * `fr-CA`, a little Spanish.
 */

const intake = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/customer-intake.translations.json"), "utf8")) as FormDefinition;

afterEach(() => {
  document.body.innerHTML = "";
});

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 100): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function runtimeFor(definition: FormDefinition, locale?: string, translationCatalog?: TranslationCatalog): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    ...(translationCatalog ? { translationCatalog } : {})
  });
}

async function mount(runtime: FormRuntime, setup?: (element: DatumFormRendererElement) => void) {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  const root = element.shadowRoot!;
  await until(() => root.querySelector("form"));
  await wait(20);
  return { element, root };
}

/** The words the field's control is named by: its `<label>`. */
const labelOf = (root: ShadowRoot, componentId: string): string | undefined => {
  const control = root.querySelector<HTMLInputElement>(`[data-component-id="${componentId}"] :is(input, select, textarea)`);
  return control?.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim();
};

/** What describes the field's control (its hint, its error), by the ids it names. */
const describedOf = (root: ShadowRoot, componentId: string): string => {
  const control = root.querySelector<HTMLElement>(`[data-component-id="${componentId}"] :is(input, select, textarea)`);
  return (control?.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id !== "")
    .map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");
};

/** Every heading the form draws, in order. */
const headings = (root: ShadowRoot): string[] => Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")).map((heading) => heading.textContent?.trim() ?? "");

/** The language switcher: the one select that is no field's. */
const switcher = (root: ShadowRoot): HTMLSelectElement | undefined => Array.from(root.querySelectorAll("select")).find((select) => select.closest("[data-component-id]") === null);

const words = (root: ShadowRoot): string => (root.querySelector("form")?.textContent ?? "").replace(/\s+/g, " ");

describe("the renderer element words every text from the definition's map", () => {
  it("shows the default language, then re-words labels, options, chrome and the title when the locale switches", async () => {
    const runtime = runtimeFor(intake);
    const { root } = await mount(runtime);
    expect(labelOf(root, "fullName")).toContain("Full name");
    expect(headings(root)).toContain("Apply for a benefit");
    expect(switcher(root)?.labels?.[0]?.textContent?.trim()).toBe("Language");

    runtime.setLocale("fr-CA");
    await wait(30);
    expect(labelOf(root, "fullName")).toContain("Nom complet");
    expect(headings(root)).toContain("Demander une prestation");
    expect(switcher(root)?.labels?.[0]?.textContent?.trim()).toBe("Langue");
    // The footer part has no French either.
    expect(words(root)).toContain("Need help? Call us.");

    runtime.setLocale("es");
    await wait(30);
    expect(labelOf(root, "fullName")).toContain("Nombre completo");
    expect(headings(root)).toContain("Apply for a benefit");
  });

  // Needs the option states built with the map: `render/react/interactive-renderer.ts` and
  // `render/readonly/readonly-renderer.ts` pass `modelContext.translations` on.
  it("words an inline option by its value, and leaves one with no entry in the default language", async () => {
    const runtime = runtimeFor(intake);
    const { root } = await mount(runtime);
    expect(root.querySelector('option[value="email"]')?.textContent?.trim()).toBe("Email");
    runtime.setLocale("fr-CA");
    await wait(30);
    expect(root.querySelector('option[value="email"]')?.textContent?.trim()).toBe("Courriel");
    expect(root.querySelector('option[value="sms"]')?.textContent?.trim()).toBe("Text message");
    runtime.setLocale("es");
    await wait(30);
    expect(root.querySelector('option[value="email"]')?.textContent?.trim()).toBe("Correo electrónico");
  });

  it("re-words a shown error when the locale switches, the form's own message and the field's own", async () => {
    const runtime = runtimeFor(intake);
    const { root } = await mount(runtime);
    await runtime.validate();
    await until(() => root.querySelector('[data-component-id="fullName"][data-invalid]'));
    expect(describedOf(root, "fullName")).toContain("Enter your full name.");

    runtime.setLocale("fr-CA");
    await until(() => describedOf(root, "fullName").includes("Entrez votre nom complet."));
    expect(describedOf(root, "fullName")).not.toContain("Enter your full name.");
  });

  it("lets the host's catalog word a text over the definition's own, and the host's own parts keep their words", async () => {
    const catalog: TranslationCatalog = { "fr-CA": { components: { fullName: { label: "Nom (catalogue)" } }, chrome: { welcome: { text: "Bienvenue (hôte)" } } } };
    const runtime = runtimeFor(intake, undefined, catalog);
    runtime.setLocale("fr-CA");
    const { root } = await mount(runtime, (element) => {
      element.chrome = {
        footer: [{ type: "text", text: { default: "Powered by the host", locales: { "fr-CA": "Propulsé par l'hôte" } } }]
      } as never;
    });
    expect(labelOf(root, "fullName")).toContain("Nom (catalogue)");
    expect(headings(root)).toContain("Bienvenue (hôte)");
    // The contact label has no catalog entry: the map's own French stands.
    expect(labelOf(root, "contact")).toContain("Mode de contact préféré");
    // A host part is host data, with its words in each language inline.
    expect(words(root)).toContain("Propulsé par l'hôte");
  });

  it("puts the host's messages catalog on top of a message the field authors, and a stale entry still words", async () => {
    const stale = structuredClone(intake);
    // The entry answered other wording ("source" differs): the renderer still shows it.
    stale.translations!["fr-CA"]!.components!.fullName!.label = { text: "Nom (ancien)", source: "0" };
    const runtime = runtimeFor(stale);
    runtime.setLocale("fr-CA");
    const { root, element } = await mount(runtime);
    expect(labelOf(root, "fullName")).toContain("Nom (ancien)");
    await runtime.validate();
    await until(() => root.querySelector('[data-component-id="fullName"][data-invalid]'));
    // Without a page entry for the code, the field's own message stands, translated.
    expect(describedOf(root, "fullName")).toContain("Entrez votre nom complet.");
    // The page's catalog outranks it for every code it names.
    element.messages = { required: "Page: required" };
    await until(() => describedOf(root, "fullName").includes("Page: required"));
  });

  it("words a pattern error's own message in the run's locale through the runtime's context, as the kernel does", async () => {
    const runtime = runtimeFor(intake);
    runtime.setLocale("fr-CA");
    runtime.setValue("fullName", "x");
    runtime.setValue("newsletterEmail", "nope");
    const errors = await runtime.validate();
    const pattern = errors.find((error) => error.componentId === "newsletterEmail");
    expect(pattern?.code).toBe("pattern");
    expect(pattern?.parameters?.message).toBe("Entrez une adresse courriel.");
  });
});
