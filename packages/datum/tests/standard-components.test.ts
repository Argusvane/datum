import { describe, expect, it } from "vitest";
import { BuilderController, type ComponentDefinition } from "@argusvane/datum-engine";

import {
  mergeComponentDefinitions,
  standardComponentDefinitions,
  standardComponentTypes
} from "../src/standard-components.js";
import { acmeComponentsPlugin } from "./fixtures/acme-components.js";

const def = (type: string, version = "1.0.0"): ComponentDefinition => ({
  type,
  version,
  createDefault: () => ({ id: type, type, configuration: {} }),
  capabilities: []
});

describe("standard component catalogue", () => {
  it("has a definition for every palette entry, and the form root", () => {
    const definitions = new Map(standardComponentDefinitions().map((definition) => [definition.type, definition]));
    expect(definitions.has("form")).toBe(true);
    for (const entry of standardComponentTypes()) {
      expect(definitions.has(entry.type), `no definition for palette type "${entry.type}"`).toBe(true);
    }
  });

  it("seeds choice components without naming a data source", () => {
    // The demo host seeds its radios from a source it registers; a page embedding the
    // builder has no such source, so a fresh radio must not point at one that does not exist.
    for (const type of ["radio", "checkboxes", "select"]) {
      const definition = standardComponentDefinitions().find((entry) => entry.type === type)!;
      const configuration = definition.createDefault().configuration as { data?: unknown };
      expect(configuration.data, `${type} seeds a data source`).toBeUndefined();
    }
  });

  it("starts a new select, radio group and checkboxes with two distinct placeholder options, and a label that says it is unwritten", () => {
    const controller = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } },
      componentTypes: standardComponentTypes(),
      componentDefinitions: standardComponentDefinitions()
    });
    for (const type of ["select", "radio", "checkboxes"]) {
      controller.add(type);
      const node = controller.selectedNode()!;
      const configuration = node.configuration as { label: string; options: Array<{ value: string; label: string }> };
      expect(configuration.label, `${type} label`).toBe("Untitled field");
      expect(configuration.options.map((option) => option.label), `${type} options`).toEqual(["Option 1", "Option 2"]);
      expect(new Set(configuration.options.map((option) => option.value)).size, `${type} keys`).toBe(2);
    }
    // Two adds do not share one list: editing the first leaves the next one's as seeded.
    controller.add("radio");
    controller.add("radio");
    const radios = controller.snapshot().children!.content!.filter((node) => node.type === "radio");
    (radios[0]!.configuration as { options: unknown[] }).options.length = 0;
    expect((radios[1]!.configuration as { options: unknown[] }).options.length).toBe(2);
    // A plain field has no options, only the label.
    controller.add("text");
    expect(controller.selectedNode()!.configuration).toEqual({ label: "Untitled field" });
  });

  it("does not seed options into a form read from JSON: a choice with none keeps none", () => {
    const controller = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "pick", type: "radio", configuration: { label: "Pick" } }, { id: "few", type: "select", configuration: { label: "Few", options: [{ value: "a", label: "A" }] } }] }
      },
      componentTypes: standardComponentTypes(),
      componentDefinitions: standardComponentDefinitions()
    });
    const [pick, few] = controller.snapshot().children!.content!;
    expect(pick!.configuration).toEqual({ label: "Pick" });
    expect((few!.configuration as { options: unknown[] }).options).toEqual([{ value: "a", label: "A" }]);
  });

  it("carries no plugin component: a component library is a plugin the host registers", () => {
    expect(standardComponentDefinitions().some((definition) => definition.type.startsWith("acme-"))).toBe(false);
    expect(standardComponentTypes().some((entry) => entry.type.startsWith("acme-"))).toBe(false);
    // Registered, its definitions sit after the standard catalogue, before the element's own.
    const registered = acmeComponentsPlugin.components ?? [];
    const merged = mergeComponentDefinitions([], registered);
    expect(merged.slice(standardComponentDefinitions().length)).toEqual(registered);
  });

  it("layers the registered plugins' definitions between the standard catalogue and the host's own", () => {
    const pluginDate = def("date", "2.0.0");
    const hostDate = def("date", "9.0.0");
    const first = def("rating", "1.0.0");
    const second = def("rating", "2.0.0");
    const merged = mergeComponentDefinitions([hostDate], [pluginDate, first, second]);
    // The host's definition of a type wins over a plugin's, which wins over the standard one.
    expect(merged.filter((entry) => entry.type === "date")).toEqual([hostDate]);
    // Two plugins defining a type: the later registration counts, once, where the type first appeared.
    expect(merged.filter((entry) => entry.type === "rating")).toEqual([second]);
    expect(merged.slice(-2)).toEqual([second, hostDate]);
    expect(merged.length).toBe(standardComponentDefinitions().length + 1);
  });

  it("returns a fresh list each time", () => {
    const first = standardComponentDefinitions();
    const second = standardComponentDefinitions();
    expect(first).not.toBe(second);
    expect(first.map((entry) => entry.type)).toEqual(second.map((entry) => entry.type));
  });

  it("lets a host definition replace a standard type and appends new ones", () => {
    const custom: ComponentDefinition = {
      type: "date",
      version: "9.0.0",
      createDefault: () => ({ id: "date", type: "date", configuration: {} }),
      capabilities: []
    };
    const rating: ComponentDefinition = {
      type: "rating",
      version: "1.0.0",
      createDefault: () => ({ id: "rating", type: "rating", configuration: {} }),
      capabilities: []
    };
    const merged = mergeComponentDefinitions([custom, rating]);
    expect(merged.filter((entry) => entry.type === "date")).toEqual([custom]);
    expect(merged.at(-1)).toBe(rating);
    expect(merged.length).toBe(standardComponentDefinitions().length + 1);
  });
});
