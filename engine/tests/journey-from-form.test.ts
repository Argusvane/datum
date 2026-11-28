import { describe, expect, it } from "vitest";

import type { TextAddress } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { journeyPageFormIds, validateJourneyShape, type Journey } from "../form-engine/core/schema/journey.js";
import { diagnoseJourney } from "../form-engine/core/journey/journey-diagnostics.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { indexJourneyForm, pageName } from "../form-engine/builder/journey-designer/journey-components.js";
import { indexJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import {
  isOnePageShape,
  journeyFromForm,
  journeyPagesFromForm,
  unassignedMembers,
  type JourneyShape
} from "../form-engine/builder/journey-designer/journey-from-form.js";

function field(id: string, type = "text", extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, ...extra };
}

function group(id: string, type: string, children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode {
  return { id, type, configuration: { label: id }, children: { content: children }, ...extra };
}

function button(id: string): ComponentNode {
  return { id, type: "button", configuration: { label: id, action: "submit" } };
}

/** A seed form's shape, without its words. */
const SEED: ComponentNode = group("root", "form", [
  field("text_1"),
  field("country", "select"),
  field("contactMethod", "radio"),
  field("contactPrefs", "checkboxes"),
  field("birthDate", "date"),
  {
    id: "mailingAddress",
    type: "container",
    configuration: { label: "Mailing address", scopeData: true },
    children: { content: [field("street"), field("city"), field("region"), field("postalCode")] }
  },
  field("monthlyBudget", "number"),
  field("notes", "textarea"),
  field("supportingDocument", "file"),
  group("newsletter", "fieldset", [field("subscribe", "checkbox"), field("newsletterEmail")]),
  field("satisfaction", "rating"),
  button("submit_1"),
  button("submit_passkey")
]);

/** Tabs, steps, a repeating section, and what asks nothing, hidden or calculated. */
const LAYOUTS: ComponentNode = group("root", "form", [
  { id: "intro", type: "html", configuration: { content: "<p>Welcome.</p>" } },
  {
    id: "tabs_1",
    type: "tabs",
    configuration: {
      tabs: [
        { id: "personal", label: "Personal" },
        { id: "work", label: "Work" },
        { id: "empty", label: "Empty" }
      ]
    },
    children: { work: [field("employer")], personal: [field("name"), field("email")], empty: [] }
  },
  {
    id: "wizard",
    type: "steps",
    configuration: {},
    children: {
      content: [
        group("step_a", "step", [field("age", "number")], { configuration: { label: "First step" } }),
        group("step_b", "step", [field("consent", "checkbox")], { configuration: { label: "Second" } }),
        { id: "step_empty", type: "step", configuration: { label: "Nothing here" } }
      ]
    }
  },
  group("people", "panel", [field("personName"), field("personAge", "number")], { collection: { collectionPath: "people" } }),
  field("secret", "text", { configuration: { label: "secret", hidden: true } }),
  field("total", "number", { rules: { value: "age + 1" } }),
  { id: "note", type: "html", configuration: { content: "<p>Thanks.</p>" } },
  button("submit")
]);

function members(journey: Journey | { pages: Journey["pages"] }): string[][] {
  return journey.pages.map((page) => journeyPageFormIds(page));
}

function errors(root: ComponentNode, journey: Journey): string[] {
  return diagnoseJourney(root, journey)
    .filter((finding) => finding.severity === "error")
    .map((finding) => `${finding.code}: ${finding.message}`);
}

const SHAPES: JourneyShape[] = ["sections", "questions", "one-page", "questions-one-page"];

describe("journeyFromForm: sections", () => {
  it("gives a page to each group and to each run of loose fields, with the closing buttons last", () => {
    const journey = journeyFromForm(SEED, { id: "intake", shape: "sections" });
    expect(journey.pages.map((page) => page.id)).toEqual(["page-1", "page-2", "page-3", "page-4", "page-5"]);
    expect(members(journey)).toEqual([
      ["text_1", "country", "contactMethod", "contactPrefs", "birthDate"],
      ["mailingAddress"],
      ["monthlyBudget", "notes", "supportingDocument"],
      ["newsletter"],
      ["satisfaction", "submit_1", "submit_passkey"]
    ]);
    // A group's page is headed by the group, which it lists: no title of its own.
    expect(journey.pages.every((page) => page.title === undefined)).toBe(true);
  });

  it("gives a page per tab and per step under its caption, keeps entries whole, and lets what asks nothing ride along", () => {
    const pages = journeyPagesFromForm(LAYOUTS, { shape: "sections" });
    expect(pages.map((page) => [page.title, page.components])).toEqual([
      ["Personal", ["intro", "name", "email"]],
      ["Work", ["employer"]],
      ["First step", ["age"]],
      ["Second", ["consent"]],
      [undefined, ["people", "secret", "total", "note", "submit"]]
    ]);
  });

  it("reports where each page's title came from, so a caller can carry its translations", () => {
    const titleOrigins: Array<{ pageId: string; from: TextAddress }> = [];
    const pages = journeyPagesFromForm(LAYOUTS, { shape: "sections", titleOrigins });
    // A tab's caption lives under its container and tab id; a step's label is the step component's own.
    expect(titleOrigins).toContainEqual({ pageId: pages[0]!.id, from: { kind: "components", owner: "tabs_1", path: ["tabs", "personal", "label"] } });
    expect(titleOrigins.some((origin) => origin.pageId === pages[2]!.id && origin.from.kind === "components" && origin.from.path.join(".") === "label")).toBe(true);
    // A page with no title of its own has no origin.
    expect(titleOrigins.some((origin) => origin.pageId === pages[4]!.id)).toBe(false);
    const one: Array<{ pageId: string; from: TextAddress }> = [];
    const [page] = journeyPagesFromForm(SEED, { shape: "one-page", title: "Customer Intake", titleFrom: { kind: "form", path: ["title"] }, titleOrigins: one });
    expect(one).toEqual([{ pageId: page!.id, from: { kind: "form", path: ["title"] } }]);
  });

  it("never gives a calculated field a page of its own: it rides with the next page, or the run it sits in", () => {
    const total = field("total", "number", { rules: { value: "1" } });
    const between = group("root", "form", [group("g1", "panel", [field("a")]), total, group("g2", "panel", [field("b")]), button("submit")]);
    const journey = journeyFromForm(between, { id: "j", shape: "sections" });
    expect(members(journey)).toEqual([["g1"], ["total", "g2", "submit"]]);
    expect(errors(between, journey)).toEqual([]);
    const inRun = group("root", "form", [field("x"), total, field("y")]);
    expect(members({ pages: journeyPagesFromForm(inRun, { shape: "sections" }) })).toEqual([["x", "total", "y"]]);
  });

  it("lets a hidden step ride along rather than titling a page with its caption", () => {
    const steps = (children: ComponentNode[]): ComponentNode => ({ id: "wizard", type: "steps", configuration: {}, children: { content: children } });
    const step = (id: string, label: string, content: ComponentNode[], hidden = false): ComponentNode =>
      group(id, "step", content, { configuration: { label, ...(hidden ? { hidden: true } : {}) } });

    const last = group("root", "form", [steps([step("s1", "Step 1", [field("a")]), step("s2", "Secret", [field("w")], true)]), button("submit")]);
    const lastJourney = journeyFromForm(last, { id: "j", shape: "sections" });
    expect(lastJourney.pages).toEqual([{ id: "page-1", title: "Step 1", components: ["a", "s2", "submit"] }]);
    expect(errors(last, lastJourney)).toEqual([]);

    const middle = group("root", "form", [
      steps([step("s1", "Step 1", [field("a")]), step("s2", "Secret", [field("w")], true), step("s3", "Step 3", [field("c")])]),
      button("submit")
    ]);
    expect(journeyPagesFromForm(middle, { shape: "sections" }).map((page) => [page.title, page.components])).toEqual([
      ["Step 1", ["a"]],
      ["Step 3", ["s2", "c", "submit"]]
    ]);
  });
});

describe("journeyFromForm: questions", () => {
  it("gives each question a page of its own, found at any depth", () => {
    const journey = journeyFromForm(SEED, { id: "one-thing", shape: "questions" });
    expect(members(journey)).toEqual([
      ["text_1"],
      ["country"],
      ["contactMethod"],
      ["contactPrefs"],
      ["birthDate"],
      ["street"],
      ["city"],
      ["region"],
      ["postalCode"],
      ["monthlyBudget"],
      ["notes"],
      ["supportingDocument"],
      ["subscribe"],
      ["newsletterEmail"],
      ["satisfaction", "submit_1", "submit_passkey"]
    ]);
  });

  it("keeps a repeating section whole and puts what asks nothing with the next question, or the last page", () => {
    expect(members({ pages: journeyPagesFromForm(LAYOUTS, { shape: "questions" }) })).toEqual([
      ["intro", "name"],
      ["email"],
      ["employer"],
      ["age"],
      ["consent"],
      ["people", "secret", "total", "note", "submit"]
    ]);
  });
});

describe("journeyFromForm: one page", () => {
  it("puts the whole form on one page", () => {
    const journey = journeyFromForm(SEED, { id: "whole", name: "Everything", shape: "one-page" });
    expect(journey).toEqual({
      id: "whole",
      name: "Everything",
      pages: [{ id: "page-1", components: (SEED.children?.content ?? []).map((node) => node.id) }]
    });
  });

  it("titles the one page as asked, a one-page start, and never a page of the other shapes", () => {
    const title = "Customer Intake";
    expect(journeyPagesFromForm(SEED, { shape: "one-page", title })[0]?.title).toBe(title);
    expect(journeyPagesFromForm(SEED, { shape: "questions-one-page", title: "Intake" })[0]?.title).toBe("Intake");
    // A blank title is none; the other shapes take their own titles or none.
    expect(journeyPagesFromForm(SEED, { shape: "one-page", title: "  " })[0]?.title).toBeUndefined();
    expect(journeyPagesFromForm(SEED, { shape: "sections", title: "Intake" }).some((page) => page.title === "Intake")).toBe(false);
    expect(journeyPagesFromForm(SEED, { shape: "questions", title: "Intake" }).some((page) => page.title === "Intake")).toBe(false);
    expect(isOnePageShape("one-page") && isOnePageShape("questions-one-page")).toBe(true);
    expect(isOnePageShape("sections") || isOnePageShape("questions")).toBe(false);
  });
});

describe("journeyFromForm: every question on one page", () => {
  it("lifts every question out of its groups onto one page, in the order the form asks them", () => {
    const journey = journeyFromForm(SEED, { id: "flat", shape: "questions-one-page" });
    expect(members(journey)).toEqual([
      [
        "text_1",
        "country",
        "contactMethod",
        "contactPrefs",
        "birthDate",
        "street",
        "city",
        "region",
        "postalCode",
        "monthlyBudget",
        "notes",
        "supportingDocument",
        "subscribe",
        "newsletterEmail",
        "satisfaction",
        "submit_1",
        "submit_passkey"
      ]
    ]);
    expect(journey.pages[0]?.id).toBe("page-1");
  });

  it("keeps a repeating section whole, lets what asks nothing ride along, and puts the closing buttons last", () => {
    expect(members({ pages: journeyPagesFromForm(LAYOUTS, { shape: "questions-one-page" }) })).toEqual([
      ["intro", "name", "email", "employer", "age", "consent", "people", "secret", "total", "note", "submit"]
    ]);
  });
});

describe("journeyFromForm: every shape", () => {
  it("never gives a page the id of a component of the form, or one taken", () => {
    const clashing = group("root", "form", [field("page-1"), group("page-3", "fieldset", [field("inner")]), field("other")]);
    for (const shape of SHAPES) {
      const ids = journeyPagesFromForm(clashing, { shape, taken: ["page-2"] }).map((page) => page.id);
      expect(ids.some((id) => ["page-1", "page-2", "page-3", "inner", "other", "root"].includes(id))).toBe(false);
    }
    expect(journeyPagesFromForm(clashing, { shape: "questions", taken: ["page-2"] }).map((page) => page.id)).toEqual(["page-4", "page-5", "page-6"]);
    expect(journeyPagesFromForm(clashing, { shape: "questions-one-page", taken: ["page-2"] }).map((page) => page.id)).toEqual(["page-4"]);
  });

  it("asks every question of the form, with no error, on the seed and on tabs, steps and entries", () => {
    for (const root of [SEED, LAYOUTS]) {
      for (const shape of SHAPES) {
        const journey = journeyFromForm(root, { id: "made", shape });
        expect(validateJourneyShape(journey)).toEqual([]);
        expect(errors(root, journey)).toEqual([]);
        const findings = diagnoseJourney(root, journey).map((finding) => finding.code);
        expect(findings).not.toContain("component.unassigned");
        expect(findings).not.toContain("page.entry-field");
        expect(unassignedMembers(root, journey)).toEqual([]);
      }
    }
  });

  it("makes no page of an empty form", () => {
    const empty: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [] } };
    for (const shape of SHAPES) {
      expect(journeyPagesFromForm(empty, { shape })).toEqual([]);
    }
    // A form of nothing but its buttons still has somewhere to submit from.
    const buttons = group("root", "form", [button("submit_1")]);
    expect(journeyPagesFromForm(buttons, { shape: "sections" })).toEqual([{ id: "page-1", components: ["submit_1"] }]);
  });

  it("follows the host's idea of what asks nothing", () => {
    const withBanner = group("root", "form", [field("banner", "gcds-notice"), field("name")]);
    const plain = journeyPagesFromForm(withBanner, { shape: "questions" });
    expect(members({ pages: plain })).toEqual([["banner"], ["name"]]);
    const hosted = journeyPagesFromForm(withBanner, { shape: "questions", isValueless: (node) => node.type === "gcds-notice" });
    expect(members({ pages: hosted })).toEqual([["banner", "name"]]);
  });
});

describe("unassignedMembers", () => {
  it("lists what no page asks, in document order, a group none of whose contents is asked as the group", () => {
    const journey: Journey = {
      id: "partial",
      pages: [{ id: "first", components: ["text_1", "subscribe"] }, { id: "last", components: ["satisfaction"] }]
    };
    expect(unassignedMembers(SEED, journey)).toEqual([
      "country",
      "contactMethod",
      "contactPrefs",
      "birthDate",
      "mailingAddress",
      "monthlyBudget",
      "notes",
      "supportingDocument",
      "newsletterEmail"
    ]);
  });

  it("leaves out hidden, calculated and valueless components, and groups that ask nothing", () => {
    const journey: Journey = { id: "few", pages: [{ id: "p", components: ["name", "email", "employer", "consent"] }] };
    expect(unassignedMembers(LAYOUTS, journey)).toEqual(["age", "people"]);
    const info = group("root", "form", [group("about", "panel", [{ id: "blurb", type: "html", configuration: {} }]), field("name")]);
    expect(unassignedMembers(info, { id: "j", pages: [] })).toEqual(["name"]);
  });

  it("lists a hidden field a rule may show, as the diagnostics judge it, and never one hidden for good — not even an opt-in the diagnostics hold required", () => {
    const show = 'name = "x"';
    const root = group("root", "form", [
      field("name"),
      field("reveal", "text", { configuration: { label: "reveal", hidden: true, required: true }, rules: { visibleWhen: show } }),
      group("box", "fieldset", [field("boxed", "text", { configuration: { label: "boxed", hidden: true }, rules: { visibleWhen: show } })]),
      field("case_no", "text", { configuration: { label: "case_no", hidden: true, required: true, hiddenRequiredBehavior: "required", hiddenValidationBehavior: "validate" } }),
      field("secret", "text", { configuration: { label: "secret", hidden: true } })
    ]);
    const journey: Journey = { id: "j", pages: [{ id: "p", components: ["name"] }] };
    // A page can show `reveal` and `boxed` (their rule may), so they are questions to add; no
    // page can show `case_no` or `secret`, so "Add unassigned" never lists them — the tray draws
    // the opt-in from its finding instead.
    expect(unassignedMembers(root, journey)).toEqual(["reveal", "box"]);
    const reported = diagnoseJourney(root, journey)
      .filter((finding) => finding.code === "component.unassigned")
      .map((finding) => [finding.componentId, finding.severity, finding.required]);
    expect(reported).toEqual([
      ["reveal", "error", true],
      ["boxed", "warning", false],
      ["case_no", "error", true]
    ]);
  });

  it("gives what a diagnostics run reports as unassigned, nothing more", () => {
    const journey: Journey = { id: "partial", pages: [{ id: "first", components: ["street", "subscribe"] }] };
    const reported = diagnoseJourney(SEED, journey)
      .filter((finding) => finding.code === "component.unassigned")
      .map((finding) => finding.componentId);
    const listed = unassignedMembers(SEED, journey);
    // The same components, except that a group none of whose contents is asked stands for them.
    expect(listed).toEqual(reported);
    const after: Journey = { ...journey, pages: [...journey.pages, { id: "rest", components: listed }] };
    expect(diagnoseJourney(SEED, after).map((finding) => finding.code)).not.toContain("component.unassigned");
  });
});

describe("a button is never a question and never a page's title", () => {
  // The form as a new author gets it: Submit seeded first, the questions after it.
  const seeded = (): ComponentNode => group("root", "form", [button("submit"), field("name"), field("email")]);

  it("keeps a Submit seeded first off page 1 in every shape: it rides with the last (or the one) page", () => {
    expect(members({ pages: journeyPagesFromForm(seeded(), { shape: "questions" }) })).toEqual([["name"], ["email", "submit"]]);
    expect(members({ pages: journeyPagesFromForm(seeded(), { shape: "sections" }) })).toEqual([["name", "email", "submit"]]);
    expect(members({ pages: journeyPagesFromForm(seeded(), { shape: "one-page" }) })).toEqual([["name", "email", "submit"]]);
    expect(members({ pages: journeyPagesFromForm(seeded(), { shape: "questions-one-page" }) })).toEqual([["name", "email", "submit"]]);
  });

  it("treats Download and Reset as buttons too, wherever they sit, and never makes a page of them beside questions", () => {
    const root = group("root", "form", [
      field("name"),
      { id: "dl", type: "button", configuration: { label: "Download", action: "download" } },
      group("details", "panel", [field("city"), { id: "reset", type: "button", configuration: { label: "Reset", action: "reset" } }]),
      button("submit")
    ]);
    expect(members({ pages: journeyPagesFromForm(root, { shape: "questions" }) })).toEqual([["name"], ["city", "dl", "reset", "submit"]]);
    // Every component still sits on a page: nothing a client could skip.
    for (const shape of SHAPES) {
      const journey = journeyFromForm(root, { id: "j", shape });
      expect(diagnoseJourney(root, journey).map((finding) => finding.code)).not.toContain("component.unassigned");
    }
  });

  it("titles the Questions page 1 from Name, not from Submit", () => {
    const root = seeded();
    const designer = createJourneyDesigner({ formRoot: () => root, locale: () => "en" });
    const journey = journeyFromForm(root, { id: "j", shape: "questions" });
    const tree = designer.treeFromJourney(journey, { pageIds: new Map() });
    const form = indexJourneyForm(root, "en");
    expect(indexJourneyTree(tree).pages.map((page) => pageName(page, form, "en"))).toEqual(["name", "email"]);
  });

  it("lends no title from a button at the head of a hand-made page, but still from the first question", () => {
    const root = seeded();
    const designer = createJourneyDesigner({ formRoot: () => root, locale: () => "en" });
    const journey: Journey = { id: "j", pages: [{ id: "only", components: ["submit", "email"] }, { id: "last", components: ["submit"] }] };
    const tree = designer.treeFromJourney(journey, { pageIds: new Map() });
    const form = indexJourneyForm(root, "en");
    // The button-only page has nothing to borrow, so it falls back to its id.
    expect(indexJourneyTree(tree).pages.map((page) => pageName(page, form, "en"))).toEqual(["email", "last"]);
  });
});
