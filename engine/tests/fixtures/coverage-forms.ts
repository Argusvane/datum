/**
 * The forms the feature-coverage scenarios (engine/feature-coverage) mount where the shared
 * corpus (`agent-form.ts`, the form-tests fixture) has no form of the shape a feature needs:
 *
 * - {@link COVERAGE_SUMMARY_FORM}: errors of every kind a summary line links to: a required
 *   text, radios, a date, a grid's cell and a grid's own row bound;
 * - {@link COVERAGE_TABS_FORM}: three tabs, the first with no error, in a form with a left-to-right
 *   and a right-to-left locale;
 * - {@link COVERAGE_DATES_FORM}: dates (required, optional, in a grid row) for composing,
 *   incompleteness, typed months and part order;
 * - {@link COVERAGE_GRID_FORM}: a grid of two text columns with room to add, remove and move rows;
 * - {@link coverageOneBoxForm}: one required text box (a browser's implicit submission needs exactly one);
 * - {@link COVERAGE_CHROME_FORM}: header and footer parts, a frame, a language switcher, and a
 *   second language that re-words the labels, a hint, the options and the renderer's own words.
 *
 * Each is a function so every mount gets a fresh copy.
 */
import { sourceHash } from "../../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

function form(id: string, children: ComponentNode[], extra: Partial<FormDefinition> = {}, configuration: Record<string, unknown> = {}): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1.0.0",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    root: { id: "form", type: "form", configuration: { label: `Coverage ${id}`, ...configuration }, children: { content: children } },
    ...extra
  } as FormDefinition;
}

/** A translation entry for `source`, the default-language string it answers. */
const tr = (source: string, text: string) => ({ text, source: sourceHash(source) });

/**
 * Name (required), contact (radios, required), birth date (required), a grid with a required
 * cell (one row) and a grid that must hold at least two rows (none to start): on an empty check
 * the summary lists name, contact, birth, `rows[0].cost` and the second grid's own bound.
 */
export function coverageSummaryForm(): FormDefinition {
  return form("summary", [
    { id: "name", type: "text", configuration: { label: "Full name", required: true } },
    {
      id: "contact",
      type: "radio",
      configuration: {
        label: "Contact by",
        required: true,
        options: [
          { value: "email", label: "Email" },
          { value: "phone", label: "Phone" },
          { value: "post", label: "Post" }
        ]
      }
    },
    { id: "birth", type: "date", configuration: { label: "Date of birth", required: true } },
    {
      id: "rows",
      type: "dataGrid",
      configuration: { label: "Costs", minRows: 1, maxRows: 4, initialRows: 1 },
      collection: { collectionPath: "rows" },
      children: { content: [{ id: "cost", type: "number", configuration: { label: "Cost", required: true } }] }
    },
    {
      id: "pair",
      type: "dataGrid",
      configuration: { label: "Pairs", minRows: 2, maxRows: 4, initialRows: 0 },
      collection: { collectionPath: "pair" },
      children: { content: [{ id: "left", type: "text", configuration: { label: "Left" } }] }
    }
  ]);
}

/** A tabs container of three tabs (`general`, `contact`, `extra`) with a required field in the last two. */
export function coverageTabsForm(): FormDefinition {
  return form(
    "tabs",
    [
      {
        id: "sections",
        type: "tabs",
        configuration: { label: "Sections", tabs: [{ id: "general", label: "General" }, { id: "contact", label: "Contact" }, { id: "extra", label: "Extra" }] },
        children: {
          general: [{ id: "nickname", type: "text", configuration: { label: "Nickname" } }],
          contact: [{ id: "email", type: "text", configuration: { label: "Email", required: true } }],
          extra: [{ id: "code", type: "text", configuration: { label: "Code", required: true } }]
        }
      }
    ],
    { localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "ar" }] } }
  );
}

/** A required date, an optional one, and a date in a grid row. */
export function coverageDatesForm(): FormDefinition {
  return form("dates", [
    { id: "due", type: "date", configuration: { label: "Due date", required: true } },
    { id: "start", type: "date", configuration: { label: "Start date" } },
    {
      id: "trips",
      type: "dataGrid",
      configuration: { label: "Trips", minRows: 0, maxRows: 3, initialRows: 1 },
      collection: { collectionPath: "trips" },
      children: { content: [{ id: "leaves", type: "date", configuration: { label: "Leaves" } }] }
    }
  ]);
}

/** A grid of two text columns, no row to start, up to four rows, rows that can be moved. */
export function coverageGridForm(): FormDefinition {
  return form("grid", [
    { id: "title", type: "text", configuration: { label: "Title" } },
    {
      id: "items",
      type: "dataGrid",
      configuration: { label: "Items", minRows: 0, maxRows: 4, initialRows: 0, canReorder: true },
      collection: { collectionPath: "items" },
      children: {
        content: [
          { id: "sku", type: "text", configuration: { label: "Item" } },
          { id: "note", type: "text", configuration: { label: "Note" } }
        ]
      }
    }
  ]);
}

/** One required text box and nothing else a browser would submit from: Enter in it is an implicit submission. */
export function coverageOneBoxForm(): FormDefinition {
  return form("one-box", [{ id: "email", type: "text", configuration: { label: "Email address", required: true } }]);
}

/** Header (a heading, a switcher), footer (a paragraph), the `outlined` frame, and French for the words. */
export function coverageChromeForm(): FormDefinition {
  return form(
    "chrome",
    [
      { id: "given", type: "text", configuration: { label: "Given name", description: "As on your passport", required: true } },
      {
        id: "colour",
        type: "select",
        configuration: {
          label: "Colour",
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" }
          ]
        }
      },
      { id: "born", type: "date", configuration: { label: "Born" } }
    ],
    {
      translations: {
        fr: {
          components: {
            given: { label: tr("Given name", "Prénom"), description: tr("As on your passport", "Comme sur votre passeport") },
            colour: { label: tr("Colour", "Couleur"), options: { red: { label: tr("Red", "Rouge") }, blue: { label: tr("Blue", "Bleu") } } },
            born: { label: tr("Born", "Né le") }
          },
          chrome: {
            welcome: { text: tr("Welcome", "Bienvenue") },
            language: { label: tr("Language", "Langue") },
            thanks: { text: tr("Thank you for your time.", "Merci de votre temps.") }
          },
          texts: {
            form: { "summaryHeading.one": tr("{{count}} error", "{{count}} erreur"), selectEmpty: tr("Select…", "Choisir…"), dateDay: tr("Day", "Jour"), dateMonth: tr("Month", "Mois"), dateYear: tr("Year", "Année") },
            messages: { required: tr("This field is required", "Ce champ est obligatoire") }
          }
        }
      }
    },
    {
      chrome: {
        frame: "outlined",
        header: [
          { id: "welcome", type: "heading", text: "Welcome", level: 2 },
          { id: "language", type: "language-switcher", label: "Language" }
        ],
        footer: [{ id: "thanks", type: "text", text: "Thank you for your time." }]
      }
    }
  );
}
