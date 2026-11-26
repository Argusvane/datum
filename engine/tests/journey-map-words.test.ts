// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { indexJourneyForm, pageName } from "../form-engine/builder/journey-designer/journey-components.js";
import { createJourneyMap, type JourneyMapSubject } from "../form-engine/builder/journey-map/journey-map.js";
import type { JourneyMapWords } from "../form-engine/builder/journey-map/journey-map-model.js";
import { addressOf, sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import { mapSource, mapWords } from "./flowmap-words.js";
import { applyJourney, presentationRoot } from "./fixtures/presentation-form.js";

/**
 * The flow map asks the designer for its words with the journey's id as well as its name, so a
 * page can be named for the preview locale from its address.
 */

const FORM = presentationRoot();

const JOURNEY: Journey = applyJourney();

function subjectOf(journey: Journey): JourneyMapSubject {
  const { view } = mapSource(FORM, journey);
  return { journeyId: journey.id, name: () => journey.id, view: () => view, selected: () => undefined };
}

function mapOver(words: (name: string, id: string) => JourneyMapWords) {
  return createJourneyMap({
    layout: "top-down" as never,
    onSelect: () => {},
    words
  });
}

describe("the flow map's words", () => {
  it("are asked for with the journey's id beside its name", () => {
    const words = vi.fn((name: string) => mapWords(FORM, name));
    const map = mapOver(words);
    map.show(subjectOf(JOURNEY));
    expect(words).toHaveBeenCalledWith("apply", "apply");
    map.dispose();
  });

  it("name a page by its title in the preview locale, through the page's address", () => {
    const translations: FormTranslations = {
      fr: { journeys: { apply: { pages: { details: { title: { text: "Vos coordonnées", source: sourceHash("Your details") } } } } } }
    };
    expect(addressOf.journeyPage("apply", "details", "title").path).toEqual(["pages", "details", "title"]);
    const index = indexJourneyForm(FORM, "fr");
    const map = mapOver((name, id) => ({ ...mapWords(FORM, name), pageName: (page) => pageName(page, index, "fr", { translations }, id) }));
    map.show(subjectOf(JOURNEY));
    const text = map.element.textContent ?? "";
    expect(text).toContain("Vos coordonnées");
    // A page with no translation keeps its default-language title.
    expect(text).toContain("Your income");
    map.dispose();
  });
});
