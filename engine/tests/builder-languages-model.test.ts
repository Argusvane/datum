import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  addressFromRowKey,
  cellEditable,
  cellStatus,
  cellText,
  changedCells,
  filterLanguagesRows,
  languageCoverage,
  languageEntries,
  languagesEdits,
  languagesGroupsOf,
  languagesRows,
  languagesTexts,
  promotedTextCount,
  resolvedCellText,
  rowKey,
  translationColumns,
  type LanguagesPending,
  type LanguagesRow,
  type LanguagesRowsInput
} from "../form-engine/builder/languages/languages-model.js";
import * as languageEdits from "../form-engine/builder/controller/language-edits.js";
import * as model from "../form-engine/builder/languages/languages-model.js";
import { BuilderController, type TranslatableText } from "../form-engine/builder/controller/builder-controller.js";
import { addressOf, type TranslationCatalog } from "../form-engine/core/localization/translations.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";

/**
 * The Languages workspace's model over the canonical form
 * (`customer-intake.translations.json`): every text as a row by address, a cell per language
 * with its status, the typed cells as `setTranslations` edits, filters and coverage.
 */

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;

function controller(): BuilderController {
  return new BuilderController({
    initialRoot: structuredClone(fixture.root),
    componentDefinitions: AGENT_BUILDER_DEFINITIONS,
    ...(fixture.localization ? { localization: structuredClone(fixture.localization) } : {}),
    translations: structuredClone(fixture.translations)
  });
}

function inputOf(ctrl: BuilderController, extra: Partial<LanguagesRowsInput> = {}): LanguagesRowsInput {
  return { texts: ctrl.translatableTexts(), translations: ctrl.translations(), localization: ctrl.localization(), ...extra };
}

const rowOf = (rows: readonly LanguagesRow[], address: ReturnType<typeof addressOf.component>): LanguagesRow => {
  const row = rows.find((entry) => rowKey(entry.address) === rowKey(address));
  if (!row) {
    throw new Error(`no row for ${rowKey(address)}`);
  }
  return row;
};

const journeyText: TranslatableText = {
  componentId: "journey.apply",
  componentLabel: "Apply",
  propertyPath: "pages.start.title",
  label: "Page title",
  default: "Start",
  address: addressOf.journeyPage("apply", "start", "title")
};
const pdfText: TranslatableText = {
  componentId: "pdf.copy",
  componentLabel: "PDF layout · Copy",
  propertyPath: "name",
  label: "Layout name",
  default: "Copy",
  address: addressOf.pdf("copy", ["name"])
};

describe("the Languages rows", () => {
  it("lists every text with a cell per language but the default, by address", () => {
    const { rows, emptyCount } = languagesTexts(inputOf(controller()));
    const label = rowOf(rows, addressOf.component("fullName", "label"));
    expect(label).toMatchObject({ groupId: "fields", componentId: "fullName", default: "Full name", inForm: true, propertyPath: "label" });
    expect(Object.keys(label.cells)).toEqual(["fr-CA", "es"]);
    expect(label.cells["fr-CA"]).toEqual({ text: "Nom complet", stale: false });
    expect(label.cells.es).toEqual({ text: "Nombre completo", stale: false });
    // The placeholder nobody has worded is counted, not listed.
    expect(emptyCount).toBeGreaterThan(0);
    expect(rows.find((row) => row.address.path.at(-1) === "placeholder")).toBeUndefined();
    // No row carries the old shape.
    for (const row of rows) {
      expect(row).not.toHaveProperty("locales");
      expect(row).not.toHaveProperty("key");
      expect(row).not.toHaveProperty("target");
    }
  });

  it("groups by address and words options and header or footer parts from it", () => {
    const rows = languagesRows(inputOf(controller()));
    const group = (id: string) => rows.filter((row) => row.groupId === id).map((row) => [row.label, row.default]);
    expect(group("options")).toEqual([
      ["Option “email”", "Email"],
      ["Option “phone”", "Phone"],
      ["Option “phone” · Description", "Weekdays only"],
      ["Option “sms”", "Text message"]
    ]);
    expect(group("chrome")).toEqual([
      ["Header › welcome", "Apply for a benefit"],
      ["Header › switcher · Label", "Language"],
      ["Footer › help", "Need help? Call us."]
    ]);
    expect(group("messages").map(([label]) => label)).toEqual([expect.stringContaining("required"), expect.stringContaining("required")]);
    expect(rows[0]).toMatchObject({ groupId: "fields", address: addressOf.form("title"), default: "Customer Intake" });
    expect(languagesGroupsOf(rows).map((entry) => entry.id)).toEqual(["fields", "options", "messages", "chrome"]);
  });

  it("lists the modes' texts under their own groups, not in the form", () => {
    const rows = languagesRows(inputOf(controller(), { modeTexts: [journeyText, pdfText, { ...pdfText }] }));
    expect(rows.find((row) => row.groupId === "journeys")).toMatchObject({ componentLabel: "Apply", label: "Page title", default: "Start", inForm: false });
    expect(rows.filter((row) => row.groupId === "pdf")).toHaveLength(1);
    expect(languagesGroupsOf(rows).map((entry) => entry.id)).toEqual(["fields", "options", "messages", "chrome", "journeys", "pdf"]);
  });

  it("reads the cell statuses: present, missing, stale, overridden", () => {
    const ctrl = controller();
    // The default changed after the French was written: its source no longer matches.
    ctrl.setProperty("fullName", "description", "As shown on a government ID");
    const catalog: TranslationCatalog = { "fr-CA": { components: { newsletterEmail: { label: "Infolettre (page)" } } } };
    const rows = languagesRows(inputOf(ctrl, { catalog }));
    const description = rowOf(rows, addressOf.component("fullName", "description"));
    expect(description.cells["fr-CA"]).toMatchObject({ text: "Tel qu'il apparaît sur une pièce d'identité", stale: true });
    expect(cellStatus(description, "fr-CA")).toBe("stale");
    expect(cellStatus(description, "es")).toBe("missing");
    expect(cellStatus(rowOf(rows, addressOf.component("fullName", "label")), "fr-CA")).toBe("present");
    const overridden = rowOf(rows, addressOf.component("newsletterEmail", "label"));
    expect(overridden.cells["fr-CA"]).toEqual({ text: "Courriel de l'infolettre", stale: false, overriddenBy: "catalog", catalogText: "Infolettre (page)" });
    expect(cellStatus(overridden, "fr-CA")).toBe("overridden");
    expect(resolvedCellText(overridden, "fr-CA")).toBe("Infolettre (page)");
    expect(cellText(overridden, "fr-CA")).toBe("Courriel de l'infolettre");
    expect(cellStatus(overridden, "es")).toBe("missing");
  });

  it("lets a catalog's primary language serve a regional one only where the map has no text", () => {
    const catalog: TranslationCatalog = { fr: { components: { fullName: { label: "Nom (page)", placeholder: "Votre nom" } } } };
    const rows = languagesRows(inputOf(controller(), { catalog }));
    // The map's own fr-CA text beats the catalog's fr, so the label is not overridden...
    const label = rowOf(rows, addressOf.component("fullName", "label"));
    expect(cellStatus(label, "fr-CA")).toBe("present");
    expect(cellEditable(label, "fr-CA")).toBe(true);
    // ...and the stored text is what the cell says, not the page's.
    expect(resolvedCellText(label, "fr-CA")).toBe("Nom complet");
  });

  it("leaves a regional cell editable when the catalog words only its primary language, and shows that wording", () => {
    const catalog: TranslationCatalog = { fr: { form: { description: "Dites-nous comment vous joindre (page)" } } };
    const rows = languagesRows(inputOf(controller(), { catalog }));
    const description = rowOf(rows, addressOf.form("description"));
    // fr-CA has no text of its own: the page's fr stands in until the author translates it.
    expect(description.cells["fr-CA"]).toEqual({ stale: false, pageText: "Dites-nous comment vous joindre (page)" });
    expect(description.cells["fr-CA"]).not.toHaveProperty("overriddenBy");
    expect(cellEditable(description, "fr-CA")).toBe(true);
    expect(resolvedCellText(description, "fr-CA")).toBe("Dites-nous comment vous joindre (page)");
    expect(cellText(description, "fr-CA")).toBe("");
    // The map's es is another tag: nothing serves it.
    expect(description.cells.es).toEqual({ stale: false });
    // What the author types is written, and wins over the page.
    const typed: LanguagesPending = new Map([[rowKey(description.address), { "fr-CA": "Comment vous joindre" }]]);
    expect(languagesEdits(rows, typed)).toEqual([{ locale: "fr-CA", address: addressOf.form("description"), text: "Comment vous joindre" }]);
    expect(resolvedCellText(description, "fr-CA", typed)).toBe("Comment vous joindre");
  });

  it("counts a primary-subtag cell as translated only while nothing is stored or typed", () => {
    const catalog: TranslationCatalog = { fr: { form: { description: "Dites-nous (page)" } } };
    const rows = languagesRows(inputOf(controller(), { catalog }));
    const description = rowOf(rows, addressOf.form("description"));
    const without = languageCoverage(languagesRows(inputOf(controller())), "fr-CA");
    const withPage = languageCoverage(rows, "fr-CA");
    expect(cellStatus(description, "fr-CA")).toBe("present");
    expect(withPage.translated).toBe(without.translated + 1);
    expect(withPage.missing).toBe(without.missing - 1);
    expect(withPage.overridden).toBe(0);
    // Clearing what was typed over nothing leaves the page's wording; typing then clearing a stored text is the author's.
    const cleared: LanguagesPending = new Map([[rowKey(description.address), { "fr-CA": "" }]]);
    expect(cellStatus(description, "fr-CA", cleared)).toBe("present");
    // The exact tag is the page's outright: read-only, "overridden", counted translated.
    const exact = languagesRows(inputOf(controller(), { catalog: { "fr-CA": { form: { description: "Page" } } } }));
    const locked = rowOf(exact, addressOf.form("description"));
    expect(cellStatus(locked, "fr-CA")).toBe("overridden");
    expect(cellEditable(locked, "fr-CA")).toBe(false);
    expect(languageCoverage(exact, "fr-CA").overridden).toBe(1);
  });

  it("shows what only the page's catalog words as read-only rows", () => {
    const catalog: TranslationCatalog = { "fr-CA": { components: { fullName: { label: "Nom (page)", hint: "Aide de la page" } }, chrome: { banner: { text: "Bandeau" } } } };
    const rows = languagesRows(inputOf(controller(), { catalog }));
    const only = rows.filter((row) => row.groupId === "catalog");
    expect(only.map((row) => rowKey(row.address))).toEqual(["components/fullName/hint", "chrome/banner/text"]);
    expect(only[0]).toMatchObject({ default: "", inForm: false, componentLabel: "fullName", label: "hint" });
    expect(only[0]!.cells).toEqual({ "fr-CA": { stale: false, overriddenBy: "catalog", catalogText: "Aide de la page" } });
    expect(Object.keys(only[0]!.cells)).not.toContain("es");
    // A catalog row is never edited, and the coverage does not count it.
    expect(changedCells(rows, new Map([[rowKey(only[0]!.address), { "fr-CA": "x" }]]))).toEqual([]);
    expect(languageCoverage(rows, "fr-CA").total).toBe(rows.length - only.length);
  });
});

describe("row keys", () => {
  it("round-trips an address, escaping slashes and percents, never splitting on a dot", () => {
    const addresses = [
      addressOf.form("title"),
      addressOf.formMessage("journey.exit"),
      addressOf.option("contact", "a/b", "label"),
      addressOf.message("fullName", "100%.min"),
      addressOf.pdf("copy", ["nodes", "n1", "text"])
    ];
    for (const address of addresses) {
      const key = rowKey(address);
      expect(addressFromRowKey(key)).toEqual(address);
    }
    expect(rowKey(addressOf.option("contact", "a/b", "label"))).toBe("components/contact/options/a%2Fb/label");
    expect(rowKey(addressOf.form("title"))).toBe("form/title");
  });

  it("refuses a string that names no address", () => {
    for (const bad of ["", "title", "colours/x/y", "components/x", "components//label", "components/__proto__/label", "components/a/%zz", "form"]) {
      expect(addressFromRowKey(bad)).toBeUndefined();
    }
  });
});

describe("pending edits", () => {
  it("writes the typed cells as setTranslations edits, skipping unchanged and the page's cells", () => {
    const ctrl = controller();
    const catalog: TranslationCatalog = { "fr-CA": { components: { newsletterEmail: { label: "Infolettre (page)" } } } };
    const rows = languagesRows(inputOf(ctrl, { catalog }));
    const key = (address: Parameters<typeof rowKey>[0]) => rowKey(address);
    const pending: LanguagesPending = new Map([
      [key(addressOf.component("fullName", "label")), { "fr-CA": "  Nom et prénom  ", es: "Nombre completo" }],
      [key(addressOf.component("fullName", "placeholder")), { es: "Su nombre" }],
      [key(addressOf.component("newsletterEmail", "label")), { "fr-CA": "ignoré" }]
    ]);
    // "Nombre completo" is what is stored; the placeholder has no wording, so it has no row to take a cell.
    expect(languagesEdits(rows, pending)).toEqual([{ locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "Nom et prénom" }]);
  });

  it("applies the edits as one undo step through the controller", () => {
    const ctrl = controller();
    const rows = languagesRows(inputOf(ctrl));
    const pending: LanguagesPending = new Map([
      [rowKey(addressOf.option("contact", "sms", "label")), { "fr-CA": "Texto", es: "Mensaje" }],
      [rowKey(addressOf.component("contact", "label")), { es: "Contacto" }]
    ]);
    const edits = languagesEdits(rows, pending);
    expect(edits).toHaveLength(3);
    expect(ctrl.setTranslations(edits)).toBe(3);
    const after = languagesRows(inputOf(ctrl));
    expect(rowOf(after, addressOf.option("contact", "sms", "label")).cells.es).toEqual({ text: "Mensaje", stale: false });
    expect(languagesEdits(after, pending)).toEqual([]);
    ctrl.undo();
    expect(rowOf(languagesRows(inputOf(ctrl)), addressOf.option("contact", "sms", "label")).cells.es).toEqual({ stale: false });
  });

  it("clears a cell by typing nothing, and confirms a stale one typed over with the same text", () => {
    const ctrl = controller();
    ctrl.setProperty("fullName", "label", "Full legal name");
    const rows = languagesRows(inputOf(ctrl));
    const label = addressOf.component("fullName", "label");
    expect(languagesEdits(rows, new Map([[rowKey(label), { "fr-CA": "" }]]))).toEqual([{ locale: "fr-CA", address: label, text: "" }]);
    // Same words, typed again: the source is re-fingerprinted.
    expect(languagesEdits(rows, new Map([[rowKey(label), { "fr-CA": "Nom complet" }]]))).toEqual([{ locale: "fr-CA", address: label, text: "Nom complet" }]);
    ctrl.setTranslations(languagesEdits(rows, new Map([[rowKey(label), { "fr-CA": "Nom complet" }]])));
    expect(cellStatus(rowOf(languagesRows(inputOf(ctrl)), label), "fr-CA")).toBe("present");
  });

  it("takes a pending cell as the author's word in status and text", () => {
    const rows = languagesRows(inputOf(controller()));
    const phone = rowOf(rows, addressOf.option("contact", "sms", "label"));
    const pending: LanguagesPending = new Map([[rowKey(phone.address), { es: "Mensaje" }]]);
    expect(cellStatus(phone, "es")).toBe("missing");
    expect(cellStatus(phone, "es", pending)).toBe("present");
    expect(cellText(phone, "es", pending)).toBe("Mensaje");
    expect(cellStatus(phone, "es", new Map([[rowKey(phone.address), { es: "  " }]]))).toBe("missing");
  });
});

describe("filters and coverage", () => {
  const catalog: TranslationCatalog = { "fr-CA": { components: { newsletterEmail: { label: "Infolettre (page)" }, fullName: { hint: "Aide" } } } };

  function rowsWithStale(): { rows: LanguagesRow[] } {
    const ctrl = controller();
    ctrl.setProperty("fullName", "description", "As shown on a government ID");
    return { rows: languagesRows(inputOf(ctrl, { catalog })) };
  }

  it("filters by group, status, query and component", () => {
    const { rows } = rowsWithStale();
    const locales = ["fr-CA", "es"];
    const ids = (kept: LanguagesRow[]) => kept.map((row) => rowKey(row.address));
    expect(filterLanguagesRows(rows, { group: "options" }, locales)).toHaveLength(4);
    // One header or footer part's texts (the Header & footer panel's goto): its `chrome › <id> › …` rows only.
    expect(ids(filterLanguagesRows(rows, { chromePartId: "welcome" }, locales))).toEqual(["chrome/welcome/text"]);
    expect(filterLanguagesRows(rows, { chromePartId: "no-such-part" }, locales)).toEqual([]);
    expect(filterLanguagesRows(rows, { group: "catalog" }, locales).map((row) => rowKey(row.address))).toEqual(["components/fullName/hint"]);
    expect(ids(filterLanguagesRows(rows, { status: "stale" }, locales))).toEqual(["components/fullName/description"]);
    expect(ids(filterLanguagesRows(rows, { status: "overridden" }, locales))).toEqual(["components/newsletterEmail/label", "components/fullName/hint"]);
    // fr-CA alone: the title and the footer have no French, the contact label has it.
    const missingFr = ids(filterLanguagesRows(rows, { status: "missing", language: "fr-CA" }, locales));
    expect(missingFr).toContain("chrome/help/text");
    expect(missingFr).not.toContain("components/contact/label");
    expect(ids(filterLanguagesRows(rows, { query: "infolettre" }, locales))).toEqual(["components/newsletterEmail/label"]);
    // The query reads what the form shows, so the page's wording is found too.
    expect(ids(filterLanguagesRows(rows, { query: "Infolettre (page)", language: "fr-CA" }, locales))).toEqual(["components/newsletterEmail/label"]);
    // The goto event: one component's texts.
    expect(ids(filterLanguagesRows(rows, { componentId: "contact" }, locales))).toEqual([
      "components/contact/label",
      "components/contact/options/email/label",
      "components/contact/options/phone/label",
      "components/contact/options/phone/description",
      "components/contact/options/sms/label"
    ]);
    expect(ids(filterLanguagesRows(rows, { componentId: "contact", group: "options", status: "missing", language: "es" }, locales))).toEqual([
      "components/contact/options/phone/label",
      "components/contact/options/phone/description",
      "components/contact/options/sms/label"
    ]);
  });

  it("counts present over texts, stale as missing, the page's wording as translated", () => {
    const { rows } = rowsWithStale();
    const form = rows.filter((row) => row.groupId !== "catalog");
    const fr = languageCoverage(rows, "fr-CA");
    expect(fr.total).toBe(form.length);
    expect(fr).toMatchObject({ stale: 1, overridden: 1 });
    expect(fr.translated + fr.missing + fr.stale).toBe(fr.total);
    // Twelve texts show French: eleven current translations and the one the page words.
    expect(fr.translated).toBe(12);
    const es = languageCoverage(rows, "es");
    expect(es).toMatchObject({ translated: 2, stale: 0, overridden: 0 });
    const pending: LanguagesPending = new Map([[rowKey(addressOf.option("contact", "sms", "label")), { es: "Mensaje" }]]);
    expect(languageCoverage(rows, "es", pending).translated).toBe(3);
  });
});

describe("the languages", () => {
  it("lists the languages and leaves the default one without a column", () => {
    const ctrl = controller();
    expect(languageEntries(ctrl.localization()).map((entry) => [entry.code, entry.label, entry.isDefault])).toEqual([
      ["en", "English", true],
      ["fr-CA", "Français", false],
      ["es", "Español", false]
    ]);
    expect(translationColumns(ctrl.localization()).map((entry) => entry.code)).toEqual(["fr-CA", "es"]);
    expect(translationColumns(undefined)).toEqual([]);
  });

  it("counts the texts a language would promote when it becomes the default", () => {
    const rows = languagesRows(inputOf(controller()));
    expect(promotedTextCount(rows, "es")).toBe(2);
    expect(promotedTextCount(rows, "de")).toBe(0);
  });

  it("re-exports the controller's language arithmetic rather than keeping a copy", () => {
    for (const name of ["languageCodeProblem", "languageRenameProblem", "withLanguageAdded", "withLanguageRemoved", "withLanguageLabel", "withLanguageRenamed", "withDefaultLanguage", "defaultAfterRemoval", "effectiveDefaultLocale"] as const) {
      expect(model[name]).toBe(languageEdits[name]);
    }
  });
});

describe("the text search reads the labels the surface shows", () => {
  it("matches the words the grid draws, not the model's English, when it is handed them", () => {
    const rows = languagesRows(inputOf(controller()));
    const locales = ["fr-CA", "es"];
    const option = rows.find((row) => row.groupId === "options")!;
    expect(option.label).toContain("Option");
    // Without the surface's words the model's own English fields are searched.
    expect(filterLanguagesRows(rows, { query: "option" }, locales).map((row) => rowKey(row.address))).toContain(rowKey(option.address));
    // With them, the hidden English no longer matches and the shown word does.
    const shown = (row: LanguagesRow): string => (row.groupId === "options" ? `Choix\nValeur ${row.address.path[1]}` : "Texte");
    expect(filterLanguagesRows(rows, { query: "option" }, locales, undefined, shown)).toEqual([]);
    expect(filterLanguagesRows(rows, { query: "valeur" }, locales, undefined, shown).every((row) => row.groupId === "options")).toBe(true);
    expect(filterLanguagesRows(rows, { query: "valeur" }, locales, undefined, shown).length).toBeGreaterThan(0);
  });
});

describe("a regional language the form's own base language serves", () => {
  const nameLabel = addressOf.component("name", "label");
  const regional = (translations: Record<string, unknown>) =>
    new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } },
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }, { code: "fr-CA" }] },
      translations: translations as never
    });
  const french = { fr: { components: { name: { label: { text: "Nom", source: "" } } } } };

  it("counts as translated, editable, and shown as served by fr, without being the cell's own wording", () => {
    const ctrl = regional(french);
    const rows = languagesRows(inputOf(ctrl));
    const row = rowOf(rows, nameLabel);
    expect(row.cells["fr-CA"]).toEqual({ stale: false, fallbackText: "Nom", fallbackFrom: "form" });
    expect(row.cells["fr-CA"]).not.toHaveProperty("pageText");
    expect(row.cells["fr-CA"]).not.toHaveProperty("text");
    expect(cellStatus(row, "fr-CA")).toBe("present");
    expect(cellEditable(row, "fr-CA")).toBe(true);
    expect(resolvedCellText(row, "fr-CA")).toBe("Nom");
    expect(cellText(row, "fr-CA")).toBe("");
    expect(languageCoverage(rows, "fr-CA")).toMatchObject({ translated: 1, missing: 0 });
    expect(filterLanguagesRows(rows, { status: "missing" }, ["fr-CA"])).toEqual([]);
    expect(filterLanguagesRows(rows, { query: "nom" }, ["fr-CA"])).toHaveLength(1);
    // Clearing a cell typed over it leaves the base language's wording.
    const cleared: LanguagesPending = new Map([[rowKey(row.address), { "fr-CA": "" }]]);
    expect(cellStatus(row, "fr-CA", cleared)).toBe("present");
  });

  it("is not a text the cell holds: Make default promotes nothing from it, and a typed text still writes", () => {
    const rows = languagesRows(inputOf(regional(french)));
    const row = rowOf(rows, nameLabel);
    expect(promotedTextCount(rows, "fr-CA")).toBe(0);
    expect(promotedTextCount(rows, "fr")).toBe(1);
    const typed: LanguagesPending = new Map([[rowKey(row.address), { "fr-CA": "Nom (CA)" }]]);
    expect(languagesEdits(rows, typed)).toEqual([{ locale: "fr-CA", address: nameLabel, text: "Nom (CA)" }]);
  });

  it("gives way to the cell's own text and to the catalog's primary subtag, which the resolver reads first", () => {
    const own = rowOf(languagesRows(inputOf(regional({ ...french, "fr-CA": { components: { name: { label: { text: "Nom (CA)", source: "" } } } } }))), nameLabel);
    expect(own.cells["fr-CA"]).not.toHaveProperty("fallbackText");
    expect(own.cells["fr-CA"]?.text).toBe("Nom (CA)");
    const page = rowOf(languagesRows(inputOf(regional(french), { catalog: { fr: { components: { name: { label: "Nom (page)" } } } } })), nameLabel);
    expect(page.cells["fr-CA"]).toEqual({ stale: false, pageText: "Nom (page)" });
  });

  it("serves nothing for a language whose base has no text, or that is a base itself", () => {
    const rows = languagesRows(inputOf(regional({})));
    const row = rowOf(rows, nameLabel);
    expect(row.cells["fr-CA"]).toEqual({ stale: false });
    expect(cellStatus(row, "fr-CA")).toBe("missing");
    expect(rowOf(languagesRows(inputOf(regional(french))), nameLabel).cells.fr).toMatchObject({ text: "Nom" });
    expect(rowOf(languagesRows(inputOf(regional(french))), nameLabel).cells.fr).not.toHaveProperty("fallbackText");
  });
});

