import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { setJourneyDefaults } from "../form-engine/builder/journey-designer/journey-texts.js";
import { readTranslation, writeTranslation } from "../form-engine/core/localization/translations.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";

const DEFINITIONS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  // `standardFieldCapabilities` carries the print capability, which lists the note as a text.
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];

const NOTE = { kind: "components" as const, owner: "q1", path: ["print", "note"] };
const LABEL = { kind: "components" as const, owner: "q1", path: ["label"] };

function journeyWith(configuration: Record<string, unknown>): unknown {
  return {
    journeys: [{ id: "apply", name: "Apply", pages: [{ id: "start", title: "Start", components: [{ id: "q1", type: "text", configuration }] }] }]
  };
}

describe("a journey page-only node's default texts", () => {
  it("writes the print note and keeps the rest of the print block", () => {
    const next = setJourneyDefaults(journeyWith({ label: "Q", print: { show: "always", note: "Fill" } }) as never, [{ address: NOTE, default: "Remplir" }]) as never as { journeys: Array<{ pages: Array<{ components: Array<{ configuration: Record<string, unknown> }> }> }> };
    expect(next.journeys[0]!.pages[0]!.components[0]!.configuration.print).toEqual({ show: "always", note: "Remplir" });
  });

  it("makes the print block when the node has none", () => {
    const next = setJourneyDefaults(journeyWith({ label: "Q" }) as never, [{ address: NOTE, default: "Remplir" }]) as never as { journeys: Array<{ pages: Array<{ components: Array<{ configuration: Record<string, unknown> }> }> }> };
    expect(next.journeys[0]!.pages[0]!.components[0]!.configuration.print).toEqual({ note: "Remplir" });
  });

  it("writes a tab's caption by the tab's id, not its place", () => {
    const configuration = journeyWith({ tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] });
    const next = setJourneyDefaults(configuration as never, [{ address: { kind: "components", owner: "q1", path: ["tabs", "two", "label"] }, default: "Deux" }]) as never as { journeys: Array<{ pages: Array<{ components: Array<{ configuration: { tabs: Array<{ label: string }> } }> }> }> };
    expect(next.journeys[0]!.pages[0]!.components[0]!.configuration.tabs.map((tab) => tab.label)).toEqual(["One", "Deux"]);
  });

  it("drops a tab id the node does not hold", () => {
    const configuration = journeyWith({ tabs: [{ id: "one", label: "One" }] });
    expect(setJourneyDefaults(configuration as never, [{ address: { kind: "components", owner: "q1", path: ["tabs", "gone", "label"] }, default: "X" }])).toBe(configuration);
  });

  it("keeps a message code holding dots as one key", () => {
    const next = setJourneyDefaults(journeyWith({ label: "Q" }) as never, [{ address: { kind: "components", owner: "q1", path: ["messages", "a.b"] }, default: "Dotted" }]) as never as { journeys: Array<{ pages: Array<{ components: Array<{ configuration: { messages: Record<string, string> } }> }> }> };
    expect(next.journeys[0]!.pages[0]!.components[0]!.configuration.messages).toEqual({ "a.b": "Dotted" });
  });

  function setup(): { form: BuilderController; mode: ReturnType<typeof createJourneyBuilderMode> } {
    const form = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] } },
      componentDefinitions: DEFINITIONS,
      localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" }
    } as never);
    const journey = journeyWith({ label: "Q", print: { show: "always", note: "Fill only if it applies" } }) as { journeys: Array<{ pages: Array<{ components: unknown[] }> }> };
    journey.journeys[0]!.pages[0]!.components.unshift("fullName");
    const mode = createJourneyBuilderMode({ form, journey } as never);
    form.setOutsideDocuments(() => [mode.localeDocument()]);
    return { form, mode };
  }

  it("lands every text the journeys document lists", () => {
    const { mode } = setup();
    const document = mode.localeDocument();
    const listed = document.texts();
    expect(listed.some((text) => JSON.stringify(text.address) === JSON.stringify(NOTE))).toBe(true);
    for (const { address, default: current } of listed) {
      const written = document.setDefaults(document.read(), [{ address, default: `${current}!` }]);
      expect(written, `${address.kind}/${address.owner}/${address.path.join(".")}`).not.toBe(document.read());
    }
  });

  it("Make default carries the promoted print note", () => {
    const { form, mode } = setup();
    let map = writeTranslation(form.translations(), "fr", NOTE, "Remplir seulement si applicable", "Fill only if it applies");
    map = writeTranslation(map, "fr", LABEL, "Question", "Q");
    form.replaceTranslations(map);
    expect(form.localizationActions.makeDefaultLocale("fr")).toBe(true);
    const node = (mode.journeyConfiguration as never as { journeys: Array<{ pages: Array<{ components: Array<{ configuration: { label: string; print: { note: string; show: string } } }> }> }> }).journeys[0]!.pages[0]!.components[1]!;
    expect(node.configuration.label).toBe("Question");
    expect(node.configuration.print).toEqual({ show: "always", note: "Remplir seulement si applicable" });
    expect(readTranslation(form.translations(), "fr", NOTE)).toBeUndefined();
    expect(readTranslation(form.translations(), "en", NOTE)?.text).toBe("Fill only if it applies");
  });
});
