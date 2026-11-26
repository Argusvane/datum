import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sourceHash } from "@argusvane/datum-engine";

import { until } from "./helpers.js";

/**
 * The options dialog round-trips its options: opening it and applying changes
 * nothing, and the translations stored for an option (by its value, never its place) are left
 * exactly as they were, since the dialog edits the default-language strings only.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const OPTIONS = [
  { value: "a", label: "Alpha", description: "First" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" }
];

const TRANSLATIONS = {
  fr: {
    components: {
      pick: {
        options: {
          a: { label: { text: "Alfa", source: sourceHash("Alpha") }, description: { text: "Premier", source: sourceHash("First") } },
          b: { label: { text: "Bêta", source: sourceHash("Beta") } }
        }
      }
    }
  }
};

const inspector = (element: DatumFormBuilderElement): ShadowRoot =>
  element.builder!.shadowRoot!.querySelector("datum-builder-properties")!.shadowRoot!;

describe("the options dialog and translations", () => {
  it("applied unchanged, keeps every option and the translations stored for the options identical", async () => {
    const element = document.createElement("datum-form-builder");
    element.definition = {
      id: "keys", version: "1", schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
      translations: TRANSLATIONS,
      root: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "pick", type: "select", configuration: { label: "Pick", options: structuredClone(OPTIONS) } }] } }
    } as never;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-properties"));
    const controller = element.builder!.controller;
    controller.select("pick");
    await until(() => inspector(element).querySelector("[data-options-edit]"));
    inspector(element).querySelector<HTMLButtonElement>("[data-options-edit]")!.click();
    await until(() => inspector(element).querySelector("[data-options-apply]"));
    inspector(element).querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    await until(() => !inspector(element).querySelector("[data-options-apply]"));
    expect(controller.draftProperty("pick", "options")).toEqual(OPTIONS);
    expect(controller.translations()).toEqual(TRANSLATIONS);
  });
});
