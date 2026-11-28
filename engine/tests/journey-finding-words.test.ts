import { describe, expect, it } from "vitest";

import { wordDiagnostic, type FindingNames } from "../form-engine/builder/journey-designer/journey-finding-words.js";
import type { JourneyDiagnostic } from "../form-engine/core/journey/journey-diagnostics.js";

/**
 * The builder says a journey's findings in steps and labels: the
 * diagnostics keep their page ids and component ids, the author reads the titles and the labels.
 */

const NAMES: FindingNames = {
  step: (pageId) => ({ start: "Your home", check: "Check your answers", "step-2": "step-2", orphan: "Orphan" })[pageId],
  field: (componentId) => ({ fullName: "Full name", birthDate: "Date of birth", notes: "notes", email: "Email" })[componentId]
};

function said(message: string, place: Partial<JourneyDiagnostic> = {}): string {
  return wordDiagnostic({ severity: "warning", code: "page.unreachable", journeyId: "intake", message, ...place }, NAMES);
}

describe("wordDiagnostic", () => {
  it("names a step by its title and says step for page", () => {
    expect(said('Page "start" has no components the form has, so every path skips it.', { pageId: "start" })).toBe("Step “Your home” has no components the form has, so every path skips it.");
    expect(said('No path through the journey reaches page "orphan".')).toBe("No path through the journey reaches step “Orphan”.");
    expect(said('Page "start" is a Check answers page and a page "start"\'s own.')).toBe("Step “Your home” is a Check answers step and a step “Your home”'s own.");
  });

  it("names every step of a list of them, and a field by its label", () => {
    expect(said('fullName is on pages "start" and "orphan". That suits branches that exclude each other.', { componentId: "fullName" })).toBe(
      "Full name is on steps “Your home” and “Orphan”. That suits branches that exclude each other."
    );
    expect(said('Page "start" lists fullName, which is not a component of the form.', { componentId: "fullName" })).toBe("Step “Your home” lists Full name, which is not a component of the form.");
    expect(said('2 form fields are not asked: "birthDate" and "email".')).toBe("2 form fields are not asked: “Date of birth” and “Email”.");
  });

  it("names a step a route goes to, and says this journey for the journey's own id", () => {
    expect(said('Route 1 of page "start" goes on to "check", but "check" is a Check answers page, which is the last page before the end.')).toBe(
      "Route 1 of step “Your home” goes on to “Check your answers”, but “Check your answers” is a Check answers step, which is the last step before the end."
    );
    expect(said('Journey "intake" has no pages, so there is nothing to submit from.')).toBe("This journey has no steps, so there is nothing to submit from.");
    expect(said('fullName is on no page of journey "intake", so the journey never asks for it.', { componentId: "fullName" })).toBe("Full name is on no step of this journey, so the journey never asks for it.");
  });

  it("leaves alone what is not a name: a quoted value of a setting, an id with no label, a word inside an id", () => {
    expect(said('Page "start" is not checked on Continue yet asks the server; it is checked only when its validation.continue is "page", so server is ignored there.')).toBe(
      "Step “Your home” is not checked on Continue yet asks the server; it is checked only when its validation.continue is \"page\", so server is ignored there."
    );
    // An unknown id stays as written; a step or field named as its own id is not quoted again.
    expect(said('Route 2 of page "start" goes to "nowhere", which is not a page of the journey, so it is ignored.')).toBe(
      "Route 2 of step “Your home” goes to \"nowhere\", which is not a step of the journey, so it is ignored."
    );
    expect(said('Page "step-2" has no title.')).toBe('Step "step-2" has no title.');
    expect(said("notes is on no page of this journey.", { componentId: "notes" })).toBe("notes is on no step of this journey.");
    expect(said("page-only fields and the pageOf text stay.")).toBe("page-only fields and the pageOf text stay.");
  });

  it("puts a field's label for the bare id wherever it stands, but not for a call or for a word of the message itself", () => {
    expect(said("email reads email, and age() reads age.", { componentId: "email" })).toBe("Email reads Email, and age() reads age.");
    expect(wordDiagnostic({ severity: "warning", code: "rule.reads-clock", journeyId: "j", message: "age() reads age.", componentId: "age" }, { step: () => undefined, field: () => "Age" })).toBe("age() reads Age.");
    expect(wordDiagnostic({ severity: "error", code: "component.unassigned", journeyId: "j", message: "form is on no page of the form.", componentId: "form" }, { step: () => undefined, field: () => "Whole form" })).toBe(
      "form is on no step of the form."
    );
  });

  it("looks a quoted page id up as it is written, though it holds the word page or a field's id", () => {
    const names: FindingNames = { step: (pageId) => ({ "About page 2": "Your home", "the fullName check": "Check" })[pageId], field: (componentId) => ({ fullName: "Full name" })[componentId] };
    expect(wordDiagnostic({ severity: "warning", code: "page.no-title", journeyId: "j", message: 'Page "About page 2" has no title.', pageId: "About page 2" }, names)).toBe("Step “Your home” has no title.");
    expect(wordDiagnostic({ severity: "warning", code: "page.unreachable", journeyId: "j", message: 'fullName is on page "the fullName check".', componentId: "fullName" }, names)).toBe("Full name is on step “Check”.");
  });
});
