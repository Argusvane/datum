import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { FormDefinition } from "@argusvane/datum-engine";

import { journeyHeading, mount, onJourneyPage, until } from "./helpers.js";
import { box } from "./live-dom.js";

/*
 * A draft taken inside a journey names that journey. Restored into an element whose page chose
 * the whole form (`journey="form"`), the draft's own journey wins and the journey comes back
 * with the answers; choosing the whole form again afterwards leaves it.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function twoJourneys(): FormDefinition {
  return {
    id: "intake",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Intake" },
      children: {
        content: [
          { id: "fullName", type: "text", configuration: { label: "Full name" } },
          { id: "email", type: "text", configuration: { label: "Email" } }
        ]
      }
    },
    journey: {
      journeys: [
        { id: "intake", name: "Step by step", pages: [{ id: "about", title: "About you", components: ["fullName"] }, { id: "reach", title: "Reach you", components: ["email"] }] },
        { id: "quick", name: "Quick apply", pages: [{ id: "all", title: "Everything", components: ["fullName", "email"] }] }
      ]
    }
  } as unknown as FormDefinition;
}

describe("<datum-form> restoring a draft taken inside a journey", () => {
  it("puts the draft's journey back over the page's choice of the whole form, with its answers", async () => {
    // Taken inside the second, non-default journey: a restore that fell back on the definition's
    // default would open "intake", not this one.
    const first = mount((el) => {
      el.setAttribute("draft", "journey-choice-draft");
      el.journey = "quick";
      el.definition = twoJourneys();
    });
    await onJourneyPage(first, "Everything");
    await first.clearDraft();
    first.runtime!.setValue("fullName", "Ada Lovelace");
    await first.runtime!.saveDraft("journey-choice-draft");
    expect(await first.hasDraft()).toBe(true);
    first.remove();

    const again = mount((el) => {
      el.setAttribute("draft", "journey-choice-draft");
      el.journey = "form";
      el.definition = twoJourneys();
    });
    await until(() => box(again.renderer!.shadowRoot!, "fullName"));
    // The page chose the whole form: no journey page, every field on one page.
    expect(journeyHeading(again)).toBeUndefined();
    expect(box(again.renderer!.shadowRoot!, "email")).not.toBeNull();
    expect(again.runtime!.journeyView()).toBeUndefined();

    await again.restoreDraft();
    await onJourneyPage(again, "Everything");
    expect(again.runtime!.journeyView()?.journeyId).toBe("quick");
    expect(again.values.fullName).toBe("Ada Lovelace");
    expect(box(again.renderer!.shadowRoot!, "fullName").querySelector("input")!.value).toBe("Ada Lovelace");

    await again.clearDraft();
  });
});
