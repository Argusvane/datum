import type { FormTranslations } from "../form-engine/core/localization/translations.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

/**
 * The print fixtures: one form per class of print bug Enketo's issue tracker records
 * for paper forms, each printed with its answers and blank, in English and (one) in French, and
 * checked in headless Chromium by `run.mjs` (the PDF's text and its pages as pictures).
 *
 * - overlap: blocks drawn over one another (fields, hints, option lists, nested groups across a page break);
 * - dates: a date answer missing or clipped on paper;
 * - long-text: a long answer cut off (a textarea's rows, a one-line box, an unbroken word);
 * - readonly: a read-only or disabled form printed greyed out, or with its controls;
 * - grid: a grid's columns lost, squeezed off the page or split across a page;
 * - tabs, journey: a tab or a journey page missing from paper;
 * - looks: a panel's look (outlined, shaded, card) lost on paper, or its box split without its border.
 *
 * `expect` names what the check looks for: `text` must be in the PDF in the answers rendition,
 * `blankText` in the blank one (where none of `answersOnly` may be), and every `[label, answer]`
 * of `together` on one page. The filled rendition carries the answers in the paper form's boxes,
 * so `filledText` (else `answersOnly`) must be in its PDF: a date there is its boxes' values, not
 * the worded line. `groupLooks` names the `[panel id, look]` pairs whose group element must carry
 * the look's class in every rendition (`dp-group--<look>`), the PDF's text not being able to tell.
 */
export interface PrintFixture {
  id: string;
  /** The Enketo bug class it covers. */
  bugClass: string;
  definition: FormDefinition;
  /** Value path → answer, written in order (a grid's rows are added for its entries). */
  answers: ReadonlyArray<readonly [string, unknown]>;
  locale?: string;
  mode?: "interactive" | "readonly";
  /** The paper sizes it prints on (default A4). */
  sizes?: ReadonlyArray<"A4" | "letter">;
  expect: {
    text: readonly string[];
    blankText: readonly string[];
    answersOnly: readonly string[];
    /** What the filled rendition must print, where it words an answer otherwise than the answers rendition (a date as its parts); `answersOnly` when absent. */
    filledText?: readonly string[];
    /** `[component id, look]`: the drawn group is `dp-group--<look>`. */
    groupLooks?: ReadonlyArray<readonly [string, string]>;
    together?: ReadonlyArray<readonly [string, string]>;
    /** Headings that must come in this order in the PDF's text (tabs, steps, journey pages). */
    order?: readonly string[];
  };
}

const LOCALES = { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] };

function form(id: string, title: string, children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id,
    version: "1",
    schemaVersion: "1",
    localization: LOCALES,
    root: { id: "root", type: "form", configuration: { title }, children: { content: children } },
    ...extra
  } as FormDefinition;
}

const text = (id: string, label: string, configuration: Record<string, unknown> = {}): ComponentNode => ({ id, type: "text", configuration: { label, ...configuration } });
const radios = (id: string, label: string, options: Array<[string, string, string?]>): ComponentNode => ({
  id,
  type: "radio",
  configuration: { label, options: options.map(([value, optionLabel, description]) => ({ value, label: optionLabel, ...(description ? { description } : {}) })) }
});

// ── overlap ───────────────────────────────────────────────────────────────────────────────────

function overlap(): PrintFixture {
  const sections: ComponentNode[] = Array.from({ length: 6 }, (_, s) => ({
    id: `section${s + 1}`,
    type: "fieldset",
    configuration: { label: `Section ${s + 1}: household member details`, description: "Answer for the person named first on the lease." },
    children: {
      content: [
        text(`given${s + 1}`, `Given name of member ${s + 1}`, { description: "As it appears on a government-issued identity document" }),
        text(`family${s + 1}`, `Family name of member ${s + 1}`),
        radios(`status${s + 1}`, `Residency status of member ${s + 1}`, [
          ["citizen", "Citizen", "Born or naturalized in the country"],
          ["resident", "Permanent resident"],
          ["other", "Other status", "Work or study permit, refugee claimant, visitor"]
        ]),
        {
          id: `inner${s + 1}`,
          type: "fieldset",
          configuration: { label: `Contact for member ${s + 1}` },
          children: { content: [text(`phone${s + 1}`, `Telephone number of member ${s + 1}`, { prefix: "+1" })] }
        }
      ]
    }
  }));
  const answers: Array<readonly [string, unknown]> = [];
  for (let s = 1; s <= 6; s += 1) {
    answers.push([`given${s}`, `Givenname${s}`], [`family${s}`, `Familyname${s}`], [`status${s}`, s % 2 === 0 ? "resident" : "citizen"], [`phone${s}`, `613555010${s}`]);
  }
  return {
    id: "overlap",
    bugClass: "overlapping blocks",
    definition: form("overlap", "Household application", sections),
    answers,
    sizes: ["A4", "letter"],
    expect: {
      text: ["Household application", "Section 6: household member details", "Givenname1", "Familyname6", "+16135550106", "Permanent resident"],
      blankText: ["Given name of member 6", "Other status", "Telephone number of member 3"],
      answersOnly: ["Givenname1", "Familyname6"],
      together: Array.from({ length: 6 }, (_, s) => [`Given name of member ${s + 1}`, `Givenname${s + 1}`] as const)
    }
  };
}

// ── dates ─────────────────────────────────────────────────────────────────────────────────────

function dates(): PrintFixture {
  return {
    id: "dates",
    bugClass: "missing or clipped date answers",
    definition: form("dates", "Key dates", [
      { id: "born", type: "date", configuration: { label: "Date of birth" } },
      { id: "arrived", type: "date", configuration: { label: "Date you arrived", description: "The day you first entered the country" } },
      { id: "ends", type: "date", configuration: { label: "Lease end date" } },
      { id: "unknown", type: "date", configuration: { label: "Date of the last inspection" } },
      {
        id: "visits",
        type: "dataGrid",
        configuration: { label: "Visits" },
        collection: { collectionPath: "visits" },
        children: { content: [{ id: "on", type: "date", configuration: { label: "On" } }, text("why", "Reason")] }
      }
    ]),
    answers: [
      ["born", "1999-09-09"],
      ["arrived", "2026-03-15"],
      ["ends", "2026-12-31"],
      ["visits[0].on", "2025-11-30"],
      ["visits[0].why", "Check-up"],
      ["visits[1].on", "2026-01-02"],
      ["visits[1].why", "Repairs"]
    ],
    expect: {
      text: ["September 9, 1999", "March 15, 2026", "December 31, 2026", "November 30, 2025", "January 2, 2026", "Not answered"],
      blankText: ["Date of birth", "Month", "Day", "Year", "Date of the last inspection"],
      answersOnly: ["September 9, 1999", "December 31, 2026"],
      // The boxes' values (the month as its name, the day and the year apart), and the grid's cells as the one worded line.
      filledText: ["September", "9", "1999", "December", "31", "2026", "November 30, 2025", "January 2, 2026"],
      together: [
        ["Date of birth", "September 9, 1999"],
        ["Lease end date", "December 31, 2026"]
      ]
    }
  };
}

// ── long-text ─────────────────────────────────────────────────────────────────────────────────

const PARAGRAPH =
  "The ceiling in the second bedroom has leaked every time it rained since the spring, and the landlord was told in writing on three occasions. Water now runs down the inside of the north wall and the plaster has started to come away near the window frame.";
/** 95 characters with no break opportunity: a URL pasted into a box. */
export const UNBROKEN = "https://example.org/a/very/long/path/that/never/stops/for/a/space/or/a/hyphen/anywhere/at/all1";
const WIDE = "Unit 4B, 1234 Very Long Street Name Boulevard, Southwest Industrial and Residential District, Municipality of the Greater Example Region";

function longText(): PrintFixture {
  return {
    id: "long-text",
    bugClass: "long text cut off",
    definition: form("long-text", "Maintenance request", [
      { id: "problem", type: "textarea", configuration: { label: "Describe the problem", rows: 2 } },
      text("address", "Address of the unit"),
      text("link", "Link to photos"),
      text("short", "Unit number")
    ]),
    answers: [
      ["problem", `${PARAGRAPH}\n\n${PARAGRAPH}\n\n${PARAGRAPH} The end of the answer.`],
      ["address", WIDE],
      ["link", UNBROKEN],
      ["short", "4B"]
    ],
    expect: {
      text: ["The end of the answer.", "Municipality of the Greater Example Region", UNBROKEN, "4B"],
      blankText: ["Describe the problem", "Link to photos"],
      answersOnly: ["The end of the answer.", "4B"]
    }
  };
}

// ── readonly ──────────────────────────────────────────────────────────────────────────────────

function readonly(): PrintFixture {
  return {
    id: "readonly",
    bugClass: "read-only decoration",
    definition: form("readonly", "Submitted application", [
      text("name", "Full name"),
      text("locked", "Case number", { disabled: true }),
      text("fixed", "Office", { readOnly: true }),
      radios("contact", "Contact by", [
        ["mail", "Mail"],
        ["email", "Email"]
      ]),
      { id: "agree", type: "checkbox", configuration: { label: "I confirm the information is true" } },
      { id: "city", type: "select", configuration: { label: "City", options: [{ value: "ott", label: "Ottawa" }, { value: "tor", label: "Toronto" }] } }
    ]),
    mode: "readonly",
    answers: [
      ["name", "Ada Lovelace"],
      ["locked", "C-2026-0042"],
      ["fixed", "Ottawa North"],
      ["contact", "email"],
      ["agree", true],
      ["city", "tor"]
    ],
    expect: {
      text: ["Ada Lovelace", "C-2026-0042", "Ottawa North", "Toronto", "I confirm the information is true"],
      blankText: ["Full name", "Case number", "Mail", "Ottawa"],
      answersOnly: ["Ada Lovelace", "C-2026-0042"]
    }
  };
}

// ── grid ──────────────────────────────────────────────────────────────────────────────────────

function grid(): PrintFixture {
  const answers: Array<readonly [string, unknown]> = [];
  for (let r = 0; r < 8; r += 1) {
    answers.push(
      [`items[${r}].item`, `Item ${r + 1} replacement part`],
      [`items[${r}].qty`, r + 1],
      [`items[${r}].price`, (r + 1) * 12.5],
      [`items[${r}].supplier`, `Supplier number ${r + 1} Incorporated`],
      [`items[${r}].notes`, r === 3 ? "Back-ordered until the end of the month; call before the delivery is booked" : "In stock"]
    );
  }
  return {
    id: "grid",
    bugClass: "grid columns",
    definition: form("grid", "Purchase order", [
      {
        id: "items",
        type: "dataGrid",
        configuration: { label: "Items ordered", rowLabel: "Line {{n}}" },
        collection: { collectionPath: "items" },
        children: {
          content: [
            text("item", "Item"),
            { id: "qty", type: "number", configuration: { label: "Quantity" } },
            { id: "price", type: "number", configuration: { label: "Unit price", prefix: "$" } },
            text("supplier", "Supplier"),
            text("notes", "Notes")
          ]
        }
      }
    ]),
    answers,
    expect: {
      text: ["Items ordered", "Quantity", "Unit price", "Supplier", "Notes", "Item 8 replacement part", "$100", "Supplier number 8 Incorporated", "call before the delivery is booked"],
      blankText: ["Items ordered", "Quantity", "Unit price", "Supplier", "Notes"],
      answersOnly: ["Item 1 replacement part", "Supplier number 8 Incorporated"]
    }
  };
}

// ── tabs ──────────────────────────────────────────────────────────────────────────────────────

function tabs(): PrintFixture {
  return {
    id: "tabs",
    bugClass: "every tab present",
    definition: form("tabs", "Profile", [
      {
        id: "sections",
        type: "tabs",
        configuration: { tabs: [{ id: "you", label: "About you" }, { id: "home", label: "Your home" }, { id: "work" }] },
        children: {
          you: [text("name", "Name")],
          home: [text("street", "Street")],
          work: [text("employer", "Employer")]
        }
      },
      {
        id: "wizard",
        type: "steps",
        configuration: {},
        children: {
          content: [
            { id: "s1", type: "step", configuration: { label: "Eligibility" }, children: { content: [text("age", "Age")] } },
            { id: "s2", type: "step", configuration: { label: "Declaration" }, children: { content: [text("sign", "Signed by")] } }
          ]
        }
      }
    ]),
    answers: [
      ["name", "Ada"],
      ["street", "12 Elm"],
      ["employer", "Analytical Engines Ltd"],
      ["age", "36"],
      ["sign", "A. Lovelace"]
    ],
    expect: {
      text: ["About you", "Your home", "Tab 3", "Eligibility", "Declaration", "Ada", "12 Elm", "Analytical Engines Ltd", "A. Lovelace"],
      blankText: ["About you", "Your home", "Tab 3", "Employer", "Declaration"],
      answersOnly: ["Analytical Engines Ltd"],
      order: ["About you", "Your home", "Tab 3", "Eligibility", "Declaration"]
    }
  };
}

// ── journey ───────────────────────────────────────────────────────────────────────────────────

function journey(): PrintFixture {
  return {
    id: "journey",
    bugClass: "every journey page present",
    definition: form(
      "journey",
      "Benefit claim",
      [
        text("name", "Your name"),
        radios("kind", "Claim type", [
          ["new", "New claim"],
          ["renew", "Renewal"]
        ]),
        text("previous", "Previous claim number"),
        text("bank", "Bank account"),
        text("never", "Asked on a page off the path")
      ],
      {
        journey: {
          journeys: [
            {
              id: "claim",
              name: "Claim",
              pages: [
                // A step has no condition of its own: the step before it routes past it.
                { id: "who", title: "Who is claiming", components: ["name", "kind"], routes: [{ when: 'kind = "new"', to: "detour" }] },
                { id: "renewal", title: "Your last claim", components: ["previous"], routes: [{ to: "pay" }] },
                { id: "detour", title: "Off the path", components: ["never"] },
                { id: "pay", title: "Getting paid", components: [{ id: "ref", type: "journey-field", configuration: { componentId: "bank" } }] }
              ]
            }
          ]
        }
      } as unknown as Partial<FormDefinition>
    ),
    answers: [
      ["name", "Ada"],
      ["kind", "renew"],
      ["previous", "CL-77"],
      ["bank", "00123-456"]
    ],
    expect: {
      text: ["Who is claiming", "Your last claim", "Getting paid", "CL-77", "00123-456"],
      blankText: ["Who is claiming", "Getting paid", "Bank account"],
      answersOnly: ["CL-77", "00123-456"],
      order: ["Who is claiming", "Your last claim", "Getting paid"]
    }
  };
}

// ── translated ────────────────────────────────────────────────────────────────────────────────

function translated(): PrintFixture {
  const base = dates();
  const t = (text: string, source: string) => ({ text, source: sourceHash(source) });
  const translations: FormTranslations = {
    fr: {
      form: { title: t("Dates clés", "Key dates") },
      components: {
        born: { label: t("Date de naissance", "Date of birth") },
        arrived: { label: t("Date d’arrivée", "Date you arrived"), description: t("Le jour de votre première entrée au pays", "The day you first entered the country") },
        ends: { label: t("Fin du bail", "Lease end date") },
        unknown: { label: t("Date de la dernière inspection", "Date of the last inspection") },
        visits: { label: t("Visites", "Visits") },
        on: { label: t("Le", "On") },
        why: { label: t("Motif", "Reason") }
      },
      texts: {
        form: {
          printEmpty: { text: "Aucune réponse", source: "x" },
          printPageNumber: { text: "Page {{page}} de {{pages}}", source: "x" },
          printChosen: { text: "Choisi", source: "x" },
          printRowNumber: { text: "No", source: "x" },
          dateDay: { text: "Jour", source: "x" },
          dateMonth: { text: "Mois", source: "x" },
          dateYear: { text: "Année", source: "x" }
        }
      }
    }
  } as unknown as FormTranslations;
  return {
    ...base,
    id: "translated",
    bugClass: "a translated form (dates in the locale's words, print words from the form's translations)",
    definition: { ...base.definition, translations },
    locale: "fr",
    expect: {
      text: ["Dates clés", "9 septembre 1999", "31 décembre 2026", "30 novembre 2025", "Aucune réponse", "Page 1 de 1", "Visites", "Motif"],
      blankText: ["Date de naissance", "Jour", "Mois", "Année", "Page 1 de 1"],
      answersOnly: ["9 septembre 1999"],
      filledText: ["septembre", "9", "1999", "décembre", "31", "2026", "30 novembre 2025", "2 janvier 2026"],
      together: [["Date de naissance", "9 septembre 1999"]]
    }
  };
}

// ── looks ─────────────────────────────────────────────────────────────────────────────────────

function looks(): PrintFixture {
  const panel = (look: string, label: string): ComponentNode => ({
    id: `panel-${look}`,
    type: "panel",
    configuration: { label, cssClass: `panel-${look}` },
    children: { content: [text(`${look}-first`, `${label} first answer`), text(`${look}-second`, `${label} second answer`)] }
  });
  return {
    id: "looks",
    bugClass: "a panel's look lost on paper",
    definition: form("looks", "Looks on paper", [panel("outlined", "Outlined box"), panel("shaded", "Shaded box"), panel("card", "Card box")]),
    answers: [
      ["outlined-first", "Outlinedone"],
      ["shaded-first", "Shadedone"],
      ["card-first", "Cardone"]
    ],
    expect: {
      text: ["Outlined box", "Shaded box", "Card box", "Outlinedone", "Shadedone", "Cardone"],
      blankText: ["Outlined box first answer", "Shaded box second answer", "Card box first answer"],
      answersOnly: ["Outlinedone", "Shadedone", "Cardone"],
      groupLooks: [
        ["panel-outlined", "outlined"],
        ["panel-shaded", "shaded"],
        ["panel-card", "card"]
      ],
      together: [["Card box first answer", "Cardone"]],
      order: ["Outlined box", "Shaded box", "Card box"]
    }
  };
}

export function printFixtures(): PrintFixture[] {
  return [overlap(), dates(), longText(), readonly(), grid(), tabs(), journey(), translated(), looks()];
}
