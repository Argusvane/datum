// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { FormTestConfiguration } from "../form-engine/core/form-tests/form-test-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/*
 * A language renamed in the Languages workspace is followed in the scenarios that set it
 * (`given locale = "fr"`), as one more edit: the driver refuses a language the form does not
 * declare, so a scenario left naming the old code could not start.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

const SOURCE = ['test "French label"', '  given locale = "fr"', "  expect fullName visible", ""].join("\n");
const TESTS: FormTestConfiguration = { scenarios: [{ id: "test-1", source: SOURCE }] };

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function mount(): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = {
    initialRoot: formRoot(),
    componentTypes: [{ type: "text", label: "Text" }],
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }] }
  };
  element.tests = TESTS;
  document.body.append(element);
  await until(() => element.shadowRoot?.querySelector("[data-tests-panel-item]"));
  return element;
}

const sources = (element: DatumBuilderElement): string[] => (element.controller.tests()?.scenarios ?? []).map((entry) => entry.source);

describe("a language renamed in the form", () => {
  it("is followed in the scenarios that set it, and a second rename follows the first", async () => {
    const element = await mount();
    expect(element.controller.localizationActions.renameLocale("fr", "fr-CA")).toBe(true);
    await until(() => sources(element)[0]!.includes('"fr-CA"'));
    expect(sources(element)[0]).toBe(SOURCE.replace('"fr"', '"fr-CA"'));
    expect(element.controller.localizationActions.renameLocale("fr-CA", "fr-FR")).toBe(true);
    await until(() => sources(element)[0]!.includes('"fr-FR"'));
    expect(sources(element)[0]).toBe(SOURCE.replace('"fr"', '"fr-FR"'));
  });

  it("is followed back by an undo of the rename", async () => {
    const element = await mount();
    element.controller.localizationActions.renameLocale("fr", "fr-CA");
    await until(() => sources(element)[0]!.includes('"fr-CA"'));
    // The rewrite is its own step, on top of the rename's.
    element.controller.undo();
    element.controller.undo();
    await until(() => sources(element)[0] === SOURCE);
    expect(element.controller.localeChangesSinceSave().renamed).toEqual([]);
  });

  it("leaves the scenarios alone after the host saves, when the new codes are the languages' own", async () => {
    const element = await mount();
    element.controller.localizationActions.renameLocale("fr", "fr-CA");
    await until(() => sources(element)[0]!.includes('"fr-CA"'));
    element.markLocalesSaved();
    const saved = sources(element)[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sources(element)[0]).toBe(saved);
  });

  it("is not undone by the controller taking the languages as its new baseline", async () => {
    const element = await mount();
    element.controller.localizationActions.renameLocale("fr", "fr-CA");
    await until(() => sources(element)[0]!.includes('"fr-CA"'));
    const renamed = sources(element)[0];
    // Setting the languages as they already stand starts the controller's lineage over and says "edit":
    // the rename vanishes from `localeChangesSinceSave`, which is no undo of it.
    element.controller.setLocalization(element.controller.localization());
    expect(element.controller.localeChangesSinceSave().renamed).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sources(element)[0]).toBe(renamed);
    // A later rename goes on from the code the scenarios hold now.
    element.controller.localizationActions.renameLocale("fr-CA", "fr-FR");
    await until(() => sources(element)[0]!.includes('"fr-FR"'));
    expect(sources(element)[0]).toBe(SOURCE.replace('"fr"', '"fr-FR"'));
  });
});
