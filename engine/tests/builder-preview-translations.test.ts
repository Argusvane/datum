// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BuilderPreviewRuntime } from "../form-engine/builder/preview/builder-preview-runtime.js";
import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { bodyText, definitionOf, drawDatum, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

const fixture = JSON.parse(
  readFileSync(new NodeURL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")
) as FormDefinition;

async function bodyIn(preview: BuilderPreviewRuntime, locale: string): Promise<string> {
  preview.setLocale(locale);
  unmountAll();
  return bodyText(await drawDatum(definitionOf([]), {}, { runtime: preview as never }));
}

describe("BuilderPreviewRuntime and the definition's translations", () => {
  it("words the canvas in the preview language from the map it was given", async () => {
    const preview = new BuilderPreviewRuntime(fixture.root, { locale: "fr-CA", translations: fixture.translations });
    expect(preview.translations()).toBe(fixture.translations);
    const body = await bodyIn(preview, "fr-CA");
    expect(body).toContain("Nom complet");
    expect(body).not.toContain(">Full name");
  });

  it("says the default language without a map, as a form declaring none does", async () => {
    const preview = new BuilderPreviewRuntime(fixture.root, { locale: "fr-CA" });
    expect(preview.translations()).toBeUndefined();
    expect(await bodyIn(preview, "fr-CA")).toContain("Full name");
  });

  it("follows a map the controller replaces, announcing it so the canvas repaints", async () => {
    const preview = new BuilderPreviewRuntime(fixture.root, { locale: "fr-CA" });
    const heard: string[] = [];
    preview.events().subscribe(FormEventType.FORM_INITIALIZED, () => heard.push("repaint"));
    preview.setTranslations(fixture.translations);
    expect(heard).toEqual(["repaint"]);
    expect(await bodyIn(preview, "fr-CA")).toContain("Nom complet");
    // The same map again is no change: no repaint.
    preview.setTranslations(fixture.translations);
    expect(heard).toEqual(["repaint"]);
  });

  it("offers the host's catalog the way FormRuntime does", () => {
    const catalog = { "fr-CA": { form: { title: "Admission" } } } as never;
    const preview = new BuilderPreviewRuntime(fixture.root, { translationCatalog: catalog });
    expect(preview.translationCatalog()).toBe(catalog);
    preview.setTranslationCatalog(undefined);
    expect(preview.translationCatalog()).toBeUndefined();
  });
});
