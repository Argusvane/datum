// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { DataSourceSet } from "../form-engine/core/schema/contracts.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";

/*
 * `<datum-builder>`'s preview setters (`binding`, `assets`, `dataSourceResolver`,
 * `dataSources`): each changes what the canvas previews with and nothing else, so a host that
 * sets one after the form was loaded (sources arriving later, its own design-system control)
 * keeps the author's edits, their history and the languages as they stand.
 */

defineDatumBuilderElement();

afterEach(() => {
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

function mount(): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = {
    initialRoot: formRoot(),
    componentTypes: [{ type: "text", label: "Text" }],
    localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" }
  };
  document.body.append(element);
  return element;
}

const childCount = (element: DatumBuilderElement): number => element.controller.snapshot().children?.content?.length ?? 0;

const sources: DataSourceSet = {
  has: (id: string) => id === "countries",
  ids: () => ["countries"],
  load: async () => ({ items: [] })
} as unknown as DataSourceSet;
const resolver = (() => undefined) as unknown as DataSourceResolver;

const setters: Array<[string, (element: DatumBuilderElement) => void, (element: DatumBuilderElement) => void]> = [
  ["binding", (element) => (element.binding = "elsewhere"), (element) => expect(element.binding).toBe("elsewhere")],
  ["assets", (element) => (element.assets = { stylesheets: [] }), (element) => expect(element.assets).toEqual({ stylesheets: [] })],
  ["dataSourceResolver", (element) => (element.dataSourceResolver = resolver), (element) => expect(element.controller.dataSourceResolver()).toBe(resolver)],
  ["dataSources", (element) => (element.dataSources = sources), (element) => expect(element.controller.dataSources()).toBe(sources)]
];

describe("a preview setter used after the form was edited", () => {
  for (const [name, set, applied] of setters) {
    it(`${name}: keeps the author's edits, their Undo and the languages`, () => {
      const element = mount();
      expect(element.controller.requestAddAfter("text")).toBe(true);
      expect(element.controller.localizationActions.removeLocale("fr")).toBe(true);
      expect(childCount(element)).toBe(2);
      set(element);
      applied(element);
      expect(childCount(element)).toBe(2);
      expect((element.controller.localization()?.supportedLocales ?? []).map((entry) => entry.code)).toEqual(["en"]);
      expect(element.controller.canUndo()).toBe(true);
      // The rest of the options still stand: a later one keeps the earlier one's value.
      expect(element.options.initialRoot).toBeDefined();
    });
  }
});
