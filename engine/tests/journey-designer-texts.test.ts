import { describe, expect, it } from "vitest";

import { journeyComponentTypes } from "../form-engine/builder/journey-designer/journey-components.js";
import { journeyEmptyStateHtml } from "../form-engine/builder/journey-designer/journey-designer-panels.js";
import { findingsSummary } from "../form-engine/builder/journey-designer/journey-checks.js";
import { builderText as mapText } from "../form-engine/builder/journey-map/journey-map-texts-en.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { JOURNEY_PAGE_TYPE } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import type { BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";

const FRENCH: BuilderTextCatalog = {
  fr: {
    "journey.designer.empty.title": "Aucun parcours",
    "journey.designer.palette.page": "Page FR",
    "journey.check.errors.one": "{count} erreur",
    "journey.map.note.nothing": "Aucun champ pour l'instant"
  }
};

describe("journey designer and map words follow the builder's catalog", () => {
  it("shows the host's override for the designer's empty state, and English without one", () => {
    expect(journeyEmptyStateHtml({ questionCount: 1, text: { locale: "fr", catalog: FRENCH } })).toContain("Aucun parcours");
    expect(journeyEmptyStateHtml({ questionCount: 1 })).toContain("No journeys yet");
  });

  it("names the palette's page type in the host's catalog", () => {
    const page = journeyComponentTypes({ locale: "fr", catalog: FRENCH }).find((entry) => entry.type === JOURNEY_PAGE_TYPE);
    expect(page?.label).toBe("Page FR");
  });

  it("counts findings in the host's words, English otherwise", () => {
    expect(findingsSummary({ errors: 1, warnings: 0 }, { locale: "fr", catalog: FRENCH })).toBe("1 erreur");
    expect(findingsSummary({ errors: 1, warnings: 2 })).toBe("1 error, 2 warnings");
  });

  it("says a step with nothing on it in the host's words, English otherwise", () => {
    expect(mapText("journey.map.note.nothing", undefined, { locale: "fr", catalog: FRENCH })).toBe("Aucun champ pour l'instant");
    expect(mapText("journey.map.note.nothing")).toBe("No fields yet");
  });

  it("relabels a built palette when the builder's words move, leaving other entries alone", () => {
    let locale = "en";
    const designer = createJourneyDesigner({ locale: () => locale, textCatalog: () => FRENCH, formRoot: () => ({ id: "form", type: "form" }) } as unknown as Parameters<typeof createJourneyDesigner>[0]);
    const built = [...journeyComponentTypes(), { type: "extra", label: "Extra" }];
    expect(designer.relabel(built).find((entry) => entry.type === JOURNEY_PAGE_TYPE)?.label).toBe("Step");
    locale = "fr";
    const relabelled = designer.relabel(built);
    expect(relabelled.find((entry) => entry.type === JOURNEY_PAGE_TYPE)?.label).toBe("Page FR");
    expect(relabelled.find((entry) => entry.type === "extra")?.label).toBe("Extra");
  });
});
