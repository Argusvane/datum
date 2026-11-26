import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BuilderController, type BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import { addressOf, listTranslations, readTranslation, sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { OutsideDocument } from "../form-engine/core/localization/locale-documents.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";

/**
 * The builder controller's rules for the translations map, over the canonical
 * form (`customer-intake.translations.json`): translatable texts carry addresses, delete prunes,
 * duplicate copies, an id rename moves, and the language actions (add, remove, rename, make
 * default) change the list and the map as one undo step each.
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

const textOf = (ctrl: BuilderController, id: string, path: string): unknown => ctrl.getProperty(id, path);
const entry = (ctrl: BuilderController, locale: string, address: Parameters<typeof readTranslation>[2]) => readTranslation(ctrl.translations(), locale, address);
const owners = (ctrl: BuilderController, kind: "components" | "chrome", locale: string): string[] =>
  Object.keys((ctrl.translations()?.[locale]?.[kind] ?? {}) as Record<string, unknown>);

/** Each undo step the history can take back, counted by taking them and putting them again. */
function undoDepth(ctrl: BuilderController): number {
  let depth = 0;
  while (ctrl.canUndo()) {
    ctrl.undo();
    depth += 1;
  }
  for (let step = 0; step < depth; step += 1) {
    ctrl.redo();
  }
  return depth;
}

describe("translatable texts carry their addresses", () => {
  it("lists a string in the default language and the address its translations live at, with no locales or key", () => {
    const texts = controller().translatableTexts();
    const label = texts.find((text) => text.componentId === "fullName" && text.propertyPath === "label");
    expect(label).toMatchObject({ default: "Full name", address: addressOf.component("fullName", "label") });
    expect(label).not.toHaveProperty("locales");
    expect(label).not.toHaveProperty("key");
    expect(label).not.toHaveProperty("keyDefault");
  });

  it("lists the form's own texts, messages, options and header and footer parts by id and value, never by index", () => {
    const byPath = new Map(controller().translatableTexts().map((text) => [`${text.componentId}|${text.propertyPath}`, text]));
    expect(byPath.get("root|title")?.address).toEqual(addressOf.form("title"));
    expect(byPath.get("root|messages.required")?.address).toEqual(addressOf.formMessage("required"));
    expect(byPath.get("fullName|messages.required")?.address).toEqual(addressOf.message("fullName", "required"));
    expect(byPath.get("contact|options.1.label")?.address).toEqual(addressOf.option("contact", "phone", "label"));
    expect(byPath.get("contact|options.1.description")?.address).toEqual(addressOf.option("contact", "phone", "description"));
    expect(byPath.get("root|chrome.header.0.text")?.address).toEqual(addressOf.chrome("welcome", "text"));
    expect(byPath.get("root|chrome.footer.0.text")?.address).toEqual(addressOf.chrome("help", "text"));
    expect(byPath.get("root|chrome.header.1.label")?.address).toEqual(addressOf.chrome("switcher", "label"));
    // A nested property the module does not name (the note printed beside a hidden field) sits under the component's id.
    expect(byPath.get("fullName|print.note")?.address).toEqual({ kind: "components", owner: "fullName", path: ["print", "note"] });
    for (const text of byPath.values()) {
      expect(text.address.path.every((segment) => !/^\d+$/.test(segment))).toBe(true);
    }
  });

  it("lists a tabs container's captions by the tab's own id", () => {
    const ctrl = new BuilderController({ componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    ctrl.add("tabs");
    const captions = ctrl.translatableTexts().filter((text) => text.propertyPath.startsWith("tabs."));
    expect(captions.map((text) => text.address.path)).toEqual([
      ["tabs", "tab_1", "label"],
      ["tabs", "tab_2", "label"]
    ]);
  });
});

describe("delete prunes", () => {
  it("takes the select's entries from every language in the delete's own undo step, and Undo brings them back", () => {
    const ctrl = controller();
    const before = ctrl.translations();
    ctrl.remove("contact");
    expect(owners(ctrl, "components", "fr-CA")).toEqual(["fullName", "newsletterEmail"]);
    expect(owners(ctrl, "components", "es")).toEqual(["fullName"]);
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(ctrl.translations()).toEqual(before);
    ctrl.redo();
    expect(owners(ctrl, "components", "fr-CA")).not.toContain("contact");
  });

  it("prunes every component of a removed batch and leaves the others' entries", () => {
    const ctrl = controller();
    expect(ctrl.removeComponents(["contact", "newsletterEmail"])).toEqual(["contact", "newsletterEmail"]);
    expect(owners(ctrl, "components", "fr-CA")).toEqual(["fullName"]);
    ctrl.undo();
    expect(owners(ctrl, "components", "fr-CA")).toEqual(["fullName", "contact", "newsletterEmail"]);
  });

  it("prunes an option a write deletes (the other options keep theirs) and the entries of a message code taken away", () => {
    const ctrl = controller();
    ctrl.setProperty("contact", "options", [
      { value: "email", label: "Email" },
      { value: "sms", label: "Text message" }
    ]);
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "label"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "description"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))?.text).toBe("Courriel");
    ctrl.setProperty("fullName", "messages", {});
    expect(entry(ctrl, "fr-CA", addressOf.message("fullName", "required"))).toBeUndefined();
    // Each write is one step with its pruning: two undos put both back.
    ctrl.undo();
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "label"))?.text).toBe("Téléphone");
    expect(entry(ctrl, "fr-CA", addressOf.message("fullName", "required"))?.text).toBe("Entrez votre nom complet.");
  });

  it("moves the entries of an option whose value is retyped, and drops a header part's entries with the part", () => {
    const ctrl = controller();
    ctrl.setProperty("contact", "options", [
      { value: "courriel", label: "Email" },
      { value: "phone", label: "Phone", description: "Weekdays only" },
      { value: "sms", label: "Text message" }
    ]);
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "courriel", "label"))?.text).toBe("Courriel");
    expect(entry(ctrl, "es", addressOf.option("contact", "courriel", "label"))?.text).toBe("Correo electrónico");
    const root = ctrl.snapshot();
    const configuration = structuredClone(root.configuration) as { chrome: { header: Array<{ id: string }> } };
    configuration.chrome.header = configuration.chrome.header.filter((part) => part.id !== "welcome");
    ctrl.setProperty(root.id, "chrome", configuration.chrome);
    expect(entry(ctrl, "fr-CA", addressOf.chrome("welcome", "text"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.chrome("switcher", "label"))?.text).toBe("Langue");
  });

  it("prunes through a Save of the draft too (the Form panel's route)", () => {
    const ctrl = controller();
    ctrl.select("contact");
    ctrl.setDraftProperty("contact", "options", [{ value: "email", label: "Email" }]);
    expect(ctrl.commitDraft("contact")).toBe(true);
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "label"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))?.text).toBe("Courriel");
    expect(undoDepth(ctrl)).toBe(1);
  });
});

describe("duplicate copies, a rename moves", () => {
  it("gives the copy the original's entries under its own id and leaves the original its own", () => {
    const ctrl = controller();
    const copy = ctrl.duplicate("contact");
    expect(copy).toBe("contact_2");
    expect(entry(ctrl, "fr-CA", addressOf.option("contact_2", "phone", "label"))?.text).toBe("Téléphone");
    expect(entry(ctrl, "fr-CA", addressOf.component("contact_2", "label"))?.text).toBe("Mode de contact préféré");
    expect(entry(ctrl, "es", addressOf.option("contact_2", "email", "label"))?.text).toBe("Correo electrónico");
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "label"))?.text).toBe("Téléphone");
    // Editing the copy's translation does not touch the original's.
    ctrl.setTranslations([{ locale: "fr-CA", address: addressOf.component("contact_2", "label"), text: "Contact (copie)" }]);
    expect(entry(ctrl, "fr-CA", addressOf.component("contact", "label"))?.text).toBe("Mode de contact préféré");
    // The copy and its entries are one undo step with the insert.
    ctrl.undo();
    ctrl.undo();
    expect(owners(ctrl, "components", "fr-CA")).toEqual(["fullName", "contact", "newsletterEmail"]);
  });

  it("carries a paste's translations for the languages the form declares, and only for texts the subtree words", () => {
    const ctrl = controller();
    const node: ComponentNode = { id: "pasted", type: "text", configuration: { label: "Nickname" } };
    const clipboard: FormTranslations = {
      "fr-CA": { components: { pasted: { label: { text: "Surnom", source: sourceHash("Nickname") }, unknownText: { text: "Pas de texte", source: sourceHash("x") } } } },
      de: { components: { pasted: { label: { text: "Spitzname", source: sourceHash("Nickname") } } } }
    };
    expect(ctrl.insertComponents([{ node, translations: clipboard }]).ok).toBe(true);
    expect(entry(ctrl, "fr-CA", addressOf.component("pasted", "label"))).toEqual({ text: "Surnom", source: sourceHash("Nickname") });
    expect(entry(ctrl, "fr-CA", addressOf.component("pasted", "unknownText"))).toBeUndefined();
    expect(ctrl.translations()?.de).toBeUndefined();
    expect(undoDepth(ctrl)).toBe(1);
  });

  it("keeps the exact source of a stale clipboard entry, so a paste leaves it flagged", () => {
    const ctrl = controller();
    const node: ComponentNode = { id: "pasted", type: "text", configuration: { label: "Nickname" } };
    const clipboard: FormTranslations = { "fr-CA": { components: { pasted: { label: { text: "Surnom", source: sourceHash("Alias") } } } } };
    expect(ctrl.insertComponents([{ node, translations: clipboard }]).ok).toBe(true);
    expect(entry(ctrl, "fr-CA", addressOf.component("pasted", "label"))).toEqual({ text: "Surnom", source: sourceHash("Alias") });
    expect(ctrl.translatableTexts().find((row) => row.componentId === "pasted")?.default).toBe("Nickname");
  });

  it("returns the committed map itself, not a copy, and replaces it on the next edit", () => {
    const ctrl = controller();
    const first = ctrl.translations();
    expect(ctrl.translations()).toBe(first);
    ctrl.setTranslations([{ locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "Nom et prénom" }]);
    const second = ctrl.translations();
    expect(second).not.toBe(first);
    // The earlier object was never mutated by the edit.
    expect(readTranslation(first, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
    expect("editTranslations" in ctrl).toBe(false);
  });

  it("moves the entries to the new id, reports renamedIds, and an Undo moves them back before an earlier translation step undoes", () => {
    const ctrl = controller();
    ctrl.setTranslations([{ locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "Nom et prénom" }]);
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    ctrl.renameId("fullName", "applicant");
    expect(events.at(-1)?.renamedIds).toEqual([{ kind: "components", from: "fullName", to: "applicant" }]);
    expect(owners(ctrl, "components", "fr-CA")).toEqual(["contact", "newsletterEmail", "applicant"]);
    expect(entry(ctrl, "fr-CA", addressOf.component("applicant", "label"))?.text).toBe("Nom et prénom");
    expect(entry(ctrl, "es", addressOf.component("applicant", "label"))?.text).toBe("Nombre completo");
    // The rename is one step with the entries it moved.
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom et prénom");
    expect(owners(ctrl, "components", "fr-CA")).not.toContain("applicant");
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
  });
});

describe("setTranslations and reconcileTranslations", () => {
  it("writes as one undo step with a source of the text's current default, and an empty text deletes", () => {
    const ctrl = controller();
    const written = ctrl.setTranslations([
      { locale: "es", address: addressOf.component("fullName", "description"), text: "Como en su identificación" },
      { locale: "es", address: addressOf.component("contact", "label"), text: "Medio de contacto" },
      { locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "" }
    ]);
    expect(written).toBe(3);
    expect(entry(ctrl, "es", addressOf.component("fullName", "description"))).toEqual({ text: "Como en su identificación", source: sourceHash("As it appears on a government ID") });
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))).toBeUndefined();
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
    expect(entry(ctrl, "es", addressOf.component("contact", "label"))).toBeUndefined();
  });

  it("passes over a text the form does not word, a language it does not declare and the default language", () => {
    const ctrl = controller();
    const written = ctrl.setTranslations([
      { locale: "es", address: addressOf.component("ghost", "label"), text: "Fantasma" },
      { locale: "de", address: addressOf.component("fullName", "label"), text: "Vollständiger Name" },
      { locale: "en", address: addressOf.component("fullName", "label"), text: "Full name!" }
    ]);
    expect(written).toBe(0);
    expect(ctrl.canUndo()).toBe(false);
    expect(textOf(ctrl, "fullName", "label")).toBe("Full name");
  });

  it("flags an entry stale when its default changes, and reconciling confirms it without changing its text", () => {
    const ctrl = controller();
    ctrl.setProperty("fullName", "label", "Your full name");
    const address = addressOf.component("fullName", "label");
    expect(entry(ctrl, "fr-CA", address)).toEqual({ text: "Nom complet", source: sourceHash("Full name") });
    expect(ctrl.reconcileTranslations([{ locale: "fr-CA", address }, { locale: "es", address: addressOf.component("fullName", "description") }])).toBe(1);
    expect(entry(ctrl, "fr-CA", address)).toEqual({ text: "Nom complet", source: sourceHash("Your full name") });
    expect(ctrl.reconcileTranslations([{ locale: "fr-CA", address }])).toBe(0);
  });

  it("is a no-op the history does not see when nothing changes", () => {
    const ctrl = controller();
    expect(ctrl.setTranslations([{ locale: "fr-CA", address: addressOf.component("fullName", "label"), text: "Nom complet" }])).toBe(0);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("make a language the default", () => {
  it("swaps the strings and the map in one undo step: the translation becomes the string, the old string the translation", () => {
    const ctrl = controller();
    const before = ctrl.translations();
    expect(ctrl.localizationActions.makeDefaultLocale("fr-CA")).toBe(true);
    expect(textOf(ctrl, "fullName", "label")).toBe("Nom complet");
    expect(entry(ctrl, "en", addressOf.component("fullName", "label"))).toEqual({ text: "Full name", source: sourceHash("Nom complet") });
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))).toBeUndefined();
    // Option wording and the form's title follow; a text with no French entry keeps its string.
    expect(ctrl.getProperty("contact", "options.0.label")).toBe("Courriel");
    expect(ctrl.getProperty("contact", "options.2.label")).toBe("Text message");
    expect(textOf(ctrl, "root", "title")).toBe("Accueil des clients");
    expect(textOf(ctrl, "fullName", "messages")).toEqual({ required: "Entrez votre nom complet." });
    // The header part's string is in the same entry; Spanish stays current against the new wording only if it was current against the old.
    expect((ctrl.snapshot().configuration as { chrome: { header: Array<{ text?: string }> } }).chrome.header[0]?.text).toBe("Demander une prestation");
    expect(entry(ctrl, "es", addressOf.component("fullName", "label"))).toEqual({ text: "Nombre completo", source: sourceHash("Nom complet") });
    expect(ctrl.localization()?.defaultLocale).toBe("fr-CA");
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(textOf(ctrl, "fullName", "label")).toBe("Full name");
    expect(ctrl.translations()).toEqual(before);
    expect(ctrl.localization()?.defaultLocale).toBe("en");
    ctrl.redo();
    expect(textOf(ctrl, "fullName", "label")).toBe("Nom complet");
  });

  it("rewrites the journeys' and layouts' strings through their documents in the same step", () => {
    const ctrl = controller();
    let held: unknown = { journeys: [{ id: "apply", name: "Apply", pages: [] }] };
    const document: OutsideDocument = {
      id: "journeys",
      read: () => held,
      write: (value) => {
        held = value;
      },
      texts: () => [{ address: addressOf.journey("apply", "name"), default: (held as { journeys: Array<{ name: string }> }).journeys[0]!.name }],
      setDefaults: (value, edits) => {
        const next = structuredClone(value) as { journeys: Array<{ name: string }> };
        for (const edit of edits) {
          if (edit.address.kind === "journeys") {
            next.journeys[0]!.name = edit.default;
          }
        }
        return next;
      }
    };
    ctrl.setOutsideDocuments(() => [document]);
    expect(ctrl.setTranslations([{ locale: "fr-CA", address: addressOf.journey("apply", "name"), text: "Demande" }])).toBe(1);
    expect(ctrl.localizationActions.makeDefaultLocale("fr-CA")).toBe(true);
    expect((held as { journeys: Array<{ name: string }> }).journeys[0]?.name).toBe("Demande");
    expect(entry(ctrl, "en", addressOf.journey("apply", "name"))?.text).toBe("Apply");
    ctrl.undo();
    expect((held as { journeys: Array<{ name: string }> }).journeys[0]?.name).toBe("Apply");
    expect(entry(ctrl, "fr-CA", addressOf.journey("apply", "name"))?.text).toBe("Demande");
  });

  it("refuses a language the form does not have, the one it already starts in, and while the form's settings have unsaved changes", () => {
    const ctrl = controller();
    expect(ctrl.localizationActions.makeDefaultLocale("de")).toBe(false);
    expect(ctrl.localizationActions.makeDefaultLocale("en")).toBe(false);
    ctrl.select("root");
    ctrl.setDraftProperty("root", "title", "Pending");
    expect(ctrl.localizationActions.makeDefaultLocale("fr-CA")).toBe(false);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("the other language actions", () => {
  it("removes a language and its map together, as one step", () => {
    const ctrl = controller();
    const before = ctrl.translations();
    expect(ctrl.localizationActions.removeLocale("fr-CA")).toBe(true);
    expect(ctrl.translations()?.["fr-CA"]).toBeUndefined();
    expect(ctrl.translations()?.es).toBeDefined();
    expect(ctrl.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "es"]);
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(ctrl.translations()).toEqual(before);
    expect(ctrl.localization()?.supportedLocales).toHaveLength(3);
  });

  it("removing the default language makes the next the default first, so its wording becomes the strings", () => {
    const ctrl = controller();
    expect(ctrl.localizationActions.removeLocale("en")).toBe(true);
    expect(ctrl.localization()?.defaultLocale).toBe("fr-CA");
    expect(textOf(ctrl, "fullName", "label")).toBe("Nom complet");
    expect(ctrl.translations()?.en).toBeUndefined();
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(textOf(ctrl, "fullName", "label")).toBe("Full name");
    expect(ctrl.localization()?.defaultLocale).toBe("en");
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
  });

  it("renames a language code: the map's key follows, with the default and the canvas's language", () => {
    const ctrl = controller();
    ctrl.setOptions({ locale: "fr-CA" });
    expect(ctrl.localizationActions.renameLocale("fr-CA", "fr")).toBe(true);
    expect(Object.keys(ctrl.translations() ?? {})).toEqual(["fr", "es"]);
    expect(entry(ctrl, "fr", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
    expect(ctrl.currentLocale()).toBe("fr");
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(Object.keys(ctrl.translations() ?? {})).toEqual(["fr-CA", "es"]);
    expect(ctrl.currentLocale()).toBe("fr-CA");
    expect(ctrl.localizationActions.renameLocale("fr-CA", "es")).toBe(false);
    expect(ctrl.localizationActions.renameLocale("de", "ge")).toBe(false);
  });

  it("renames the document language of the PDF layouts with the code", () => {
    const ctrl = controller();
    let held: unknown = { layouts: [{ id: "copy", accessibility: { lang: "fr-CA" } }, { id: "plain" }] };
    ctrl.setOutsideDocuments(() => [{ id: "pdf", read: () => held, write: (value) => (held = value), texts: () => [], setDefaults: (value) => value }]);
    expect(ctrl.localizationActions.renameLocale("fr-CA", "fr")).toBe(true);
    expect((held as { layouts: Array<{ accessibility?: { lang: string } }> }).layouts[0]?.accessibility?.lang).toBe("fr");
    ctrl.undo();
    expect((held as { layouts: Array<{ accessibility?: { lang: string } }> }).layouts[0]?.accessibility?.lang).toBe("fr-CA");
  });

  it("adds a language (the first one declares the source first) and relabels one", () => {
    const ctrl = controller();
    expect(ctrl.localizationActions.addLocale("de", "Deutsch")).toBe(true);
    expect(ctrl.localization()?.supportedLocales?.at(-1)).toEqual({ code: "de", label: "Deutsch" });
    expect(ctrl.localizationActions.addLocale("de")).toBe(false);
    expect(ctrl.localizationActions.addLocale("x")).toBe(false);
    expect(ctrl.localizationActions.relabelLocale("de", "Allemand")).toBe(true);
    expect(ctrl.localization()?.supportedLocales?.at(-1)).toEqual({ code: "de", label: "Allemand" });
    expect(ctrl.localizationActions.relabelLocale("de", "Allemand")).toBe(false);
    const fresh = new BuilderController({ componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    expect(fresh.localizationActions.addLocale("fr", "", { sourceLocale: "en" })).toBe(true);
    expect(fresh.localization()).toMatchObject({ defaultLocale: "en" });
    expect(fresh.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr"]);
  });

  it("drops a language the Languages workspace removes, with its entries, in that action's step", () => {
    const ctrl = controller();
    expect(ctrl.localeTranslationCount(["fr-CA"])).toBe(listTranslations(fixture.translations, "fr-CA").length);
    expect(ctrl.localizationActions.removeLocale("fr-CA")).toBe(true);
    expect(ctrl.translations()?.["fr-CA"]).toBeUndefined();
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(ctrl.translations()?.["fr-CA"]).toBeDefined();
  });
});

describe("rewriteTranslations and the host's feed", () => {
  it("runs a pure update of the map as one undo step, and answers false when it changes nothing", () => {
    const ctrl = controller();
    expect(ctrl.rewriteTranslations((map) => map)).toBe(false);
    expect(ctrl.rewriteTranslations((map) => ({ ...map, de: {} }))).toBe(true);
    expect(ctrl.canUndo()).toBe(true);
  });

  it("reads a host's map through the tolerant reader and keeps a mirror's feed out of the history", () => {
    const ctrl = new BuilderController({ translations: JSON.parse('{"fr":{"components":{"__proto__":{"label":{"text":"x","source":"y"}},"a":{"label":{"text":"A","source":"s"}}}}}') as FormTranslations });
    expect(JSON.stringify(ctrl.translations())).toBe('{"fr":{"components":{"a":{"label":{"text":"A","source":"s"}}}}}');
    ctrl.replaceTranslations(undefined, { silent: true });
    expect(ctrl.translations()).toBeUndefined();
    expect(ctrl.canUndo()).toBe(false);
  });

  it("canvas labels follow the form's translations for the language the canvas shows", () => {
    const ctrl = controller();
    expect(ctrl.treeView().slots[0]?.children[0]?.label).toBe("Full name");
    ctrl.setOptions({ locale: "fr-CA" });
    expect(ctrl.treeView().slots[0]?.children[0]?.label).toBe("Nom complet");
  });
});

describe("renames inside a configuration move their entries ", () => {
  it("moves a header part's entries to its new id: welcome becomes greeting and keeps 'Demander une prestation'", () => {
    const ctrl = controller();
    const root = ctrl.snapshot();
    const configuration = structuredClone(root.configuration) as { chrome: { header: Array<{ id: string }> } };
    configuration.chrome.header[0]!.id = "greeting";
    ctrl.setProperty(root.id, "chrome", configuration.chrome);
    expect(entry(ctrl, "fr-CA", addressOf.chrome("welcome", "text"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.chrome("greeting", "text"))?.text).toBe("Demander une prestation");
    // The other part keeps its own entries; one undo takes the rename and the move back together.
    expect(entry(ctrl, "fr-CA", addressOf.chrome("switcher", "label"))?.text).toBe("Langue");
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.chrome("welcome", "text"))?.text).toBe("Demander une prestation");
    expect(entry(ctrl, "fr-CA", addressOf.chrome("greeting", "text"))).toBeUndefined();
  });

  it("does not move entries to a new id of another type, or when the old id is still there", () => {
    const ctrl = controller();
    const root = ctrl.snapshot();
    const configuration = structuredClone(root.configuration) as { chrome: { header: Array<{ id: string; type: string }>; footer: Array<{ id: string }> } };
    // The heading is replaced by a part of another type under a new id: nothing carries over.
    configuration.chrome.header[0] = { id: "banner", type: "text", text: "Hello" } as never;
    ctrl.setProperty(root.id, "chrome", configuration.chrome);
    expect(entry(ctrl, "fr-CA", addressOf.chrome("welcome", "text"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.chrome("banner", "text"))).toBeUndefined();
  });

  it("moves the renamed option's entries even when the same write deletes another option", () => {
    const ctrl = controller();
    ctrl.setProperty("contact", "options", [
      { value: "courriel", label: "Email" },
      { value: "phone", label: "Phone", description: "Weekdays only" }
    ]);
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))).toBeUndefined();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "courriel", "label"))?.text).toBe("Courriel");
    expect(entry(ctrl, "es", addressOf.option("contact", "courriel", "label"))?.text).toBe("Correo electrónico");
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "phone", "label"))?.text).toBe("Téléphone");
    // sms was deleted for real: it has no entries to keep, and nothing else was disturbed.
    ctrl.undo();
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))?.text).toBe("Courriel");
  });
});

describe("an option list rewritten whole does not carry words to unrelated options", () => {
  it("moves nothing when a same-length write changes both value and label at every place", () => {
    const ctrl = controller();
    ctrl.setProperty("contact", "options", [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "maybe", label: "Maybe" }
    ]);
    for (const value of ["yes", "no", "maybe"]) {
      expect(entry(ctrl, "fr-CA", addressOf.option("contact", value, "label")), value).toBeUndefined();
      expect(entry(ctrl, "es", addressOf.option("contact", value, "label")), value).toBeUndefined();
    }
    // The old options' entries are pruned, not left as orphans.
    expect(Object.keys((ctrl.translations()?.["fr-CA"]?.components?.contact ?? {}) as Record<string, unknown>)).not.toContain("options");
  });

  it("still moves an entry with a value retyped in place, the label unchanged", () => {
    const ctrl = controller();
    const options = (ctrl.getProperty("contact", "options") as Array<{ value: string; label: string }>).map((option) => ({ ...option }));
    options[0]!.value = "courriel";
    ctrl.setProperty("contact", "options", options);
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "courriel", "label"))?.text).toBe("Courriel");
    expect(entry(ctrl, "fr-CA", addressOf.option("contact", "email", "label"))).toBeUndefined();
  });
});

describe("an id the translations map cannot key is refused", () => {
  it.each(["constructor", "prototype", "__proto__"])("renameId to %s sets idError and leaves the entries under the old id", (id) => {
    const ctrl = controller();
    const before = ctrl.translations();
    ctrl.renameId("fullName", id);
    expect(ctrl.idError).toBeTruthy();
    expect(ctrl.snapshot().id).toBeDefined();
    expect(ctrl.translations()).toBe(before);
    expect(entry(ctrl, "fr-CA", addressOf.component("fullName", "label"))?.text).toBe("Nom complet");
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("the key order of the map across two make-default swaps", () => {
  it("saves the same JSON after swapping to fr-CA and back to en", () => {
    const ctrl = controller();
    const started = JSON.stringify(ctrl.translations());
    expect(ctrl.localizationActions.makeDefaultLocale("fr-CA")).toBe(true);
    expect(Object.keys(ctrl.translations()!)).toEqual(["en", "es"]);
    expect(ctrl.localizationActions.makeDefaultLocale("en")).toBe(true);
    expect(Object.keys(ctrl.translations()!)).toEqual(["fr-CA", "es"]);
    expect(JSON.stringify(ctrl.translations())).toBe(started);
  });
});

describe("rewriteTranslations alongside a mode's own change", () => {
  /** A command that counts what the history asks of it; its first run is the caller's own, already applied. */
  function counting() {
    const calls = { execute: 0, undo: 0 };
    return { calls, command: { id: "MODE_BLOCK", execute: () => void (calls.execute += 1), undo: () => void (calls.undo += 1) } };
  }

  it("composes the command with the map's into one undo step: one Undo undoes both, one Redo does both again", () => {
    const ctrl = controller();
    const before = ctrl.translations();
    const { calls, command } = counting();
    expect(ctrl.rewriteTranslations((map) => pruneAll(map), command)).toBe(true);
    expect(undoDepth(ctrl)).toBe(1);
    expect(calls).toEqual({ execute: 2, undo: 1 });
    // undoDepth took the step back and put it again: run on the first call and on the redo, undone once.
    ctrl.undo();
    expect(ctrl.translations()).toEqual(before);
    expect(calls.undo).toBe(2);
  });

  it("takes a list of commands, runs none when the map does not change, and records nothing", () => {
    const ctrl = controller();
    const one = counting();
    const two = counting();
    expect(ctrl.rewriteTranslations((map) => map, [one.command, two.command])).toBe(false);
    expect(ctrl.canUndo()).toBe(false);
    expect(one.calls).toEqual({ execute: 0, undo: 0 });
    expect(ctrl.rewriteTranslations((map) => pruneAll(map), [one.command, two.command])).toBe(true);
    ctrl.undo();
    expect(one.calls.undo).toBe(1);
    expect(two.calls.undo).toBe(1);
  });

  const pruneAll = (map: FormTranslations): FormTranslations => ({ ...map, de: { form: { title: { text: "Titel", source: sourceHash("x") } } } });
});

describe("the change event names every id that was re-keyed, with its kind", () => {
  function heard(ctrl: BuilderController): BuilderChangeEvent[] {
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    return events;
  }

  it("announces a header part, an option value, a journey, a layout, a journey page and a layout node", () => {
    const ctrl = controller();
    const events = heard(ctrl);
    const root = ctrl.snapshot();
    const configuration = structuredClone(root.configuration) as { chrome: { header: Array<{ id: string }> } };
    configuration.chrome.header[0]!.id = "greeting";
    ctrl.setProperty(root.id, "chrome", configuration.chrome);
    expect(events.at(-1)?.renamedIds).toEqual([{ kind: "chrome", from: "welcome", to: "greeting" }]);

    ctrl.setProperty("contact", "options", [
      { value: "courriel", label: "Email" },
      { value: "phone", label: "Phone", description: "Weekdays only" },
      { value: "sms", label: "Text message" }
    ]);
    expect(events.at(-1)?.renamedIds).toEqual([{ kind: "components", owner: "contact", within: "options", from: "email", to: "courriel" }]);

    // A mode's rule says which ids its update re-keyed.
    ctrl.rewriteTranslations(
      (map) => map,
      undefined,
      [{ kind: "journeys", from: "apply", to: "claim" }]
    );
    ctrl.rewriteTranslations(
      (map) => ({ ...map, de: { form: { title: { text: "T", source: "s" } } } }),
      undefined,
      [
        { kind: "journeys", from: "apply", to: "claim" },
        { kind: "journeys", owner: "claim", within: "pages", from: "start", to: "begin" },
        { kind: "pdf", from: "receipt", to: "invoice" },
        { kind: "pdf", owner: "invoice", within: "nodes", from: "title", to: "heading" }
      ]
    );
    expect(events.at(-1)?.renamedIds).toEqual([
      { kind: "journeys", from: "apply", to: "claim" },
      { kind: "journeys", owner: "claim", within: "pages", from: "start", to: "begin" },
      { kind: "pdf", from: "receipt", to: "invoice" },
      { kind: "pdf", owner: "invoice", within: "nodes", from: "title", to: "heading" }
    ]);
    // The announcement belongs to the one change: the next one carries none.
    ctrl.setProperty("fullName", "label", "Name");
    expect(events.at(-1)?.renamedIds).toBeUndefined();
  });

  it("announces an option or part id renamed through the draft's Save and a batch of writes", () => {
    const ctrl = controller();
    const events = heard(ctrl);
    ctrl.select("contact");
    ctrl.setDraftProperty("contact", "options", [
      { value: "courriel", label: "Email" },
      { value: "phone", label: "Phone", description: "Weekdays only" },
      { value: "sms", label: "Text message" }
    ]);
    expect(ctrl.commitDraft("contact")).toBe(true);
    expect(events.at(-1)?.renamedIds).toEqual([{ kind: "components", owner: "contact", within: "options", from: "email", to: "courriel" }]);
  });
});

describe("the root chrome refuses a part id the other region already uses", () => {
  const repeated = () => {
    const ctrl = controller();
    const root = ctrl.snapshot();
    const chrome = structuredClone((root.configuration as { chrome: { header: Array<{ id: string }>; footer: Array<{ id: string }> } }).chrome);
    chrome.footer[0]!.id = "welcome";
    return { ctrl, root, chrome };
  };

  it("refuses a direct write with a problem and makes no step", () => {
    const { ctrl, root, chrome } = repeated();
    expect(() => ctrl.setProperty(root.id, "chrome", chrome)).toThrow(/"welcome" is used twice/);
    expect(ctrl.canUndo()).toBe(false);
    expect(textOf(ctrl, root.id, "chrome.footer.0.id")).toBe("help");
  });

  it("refuses the Form panel's Save: the draft stays, the problem is on the chrome, and nothing is written", () => {
    const { ctrl, root, chrome } = repeated();
    ctrl.select(root.id);
    ctrl.setDraftProperty(root.id, "chrome", chrome);
    expect(ctrl.problemsOf(root.id).map((problem) => problem.target)).toContain("chrome");
    expect(ctrl.commitDraft(root.id)).toBe(false);
    expect(ctrl.canUndo()).toBe(false);
    expect(textOf(ctrl, root.id, "chrome.footer.0.id")).toBe("help");
    ctrl.setDraftProperty(root.id, "chrome.footer.0.id", "help");
    expect(ctrl.problemsOf(root.id).map((problem) => problem.target)).not.toContain("chrome");
  });

  it("refuses a batch of writes too, and lets a write that leaves a shared id alone through", () => {
    const { ctrl, root, chrome } = repeated();
    expect(() => ctrl.setProperties([{ componentId: root.id, propertyPath: "chrome", value: chrome }])).toThrow(/used twice/);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("setTranslations carries the file's source and can add languages in the same step", () => {
  it("writes an entry with its own source when the edit has one, so a row from an older file comes in stale", () => {
    const ctrl = controller();
    const address = addressOf.component("fullName", "label");
    expect(ctrl.setTranslations([{ locale: "es", address, text: "Nombre y apellido", source: sourceHash("Your name") }])).toBe(1);
    expect(entry(ctrl, "es", address)).toEqual({ text: "Nombre y apellido", source: sourceHash("Your name") });
    expect(ctrl.translatableTexts().find((text) => text.componentId === "fullName" && text.propertyPath === "label")?.default).toBe("Full name");
    // Without a source the entry is current, as before.
    expect(ctrl.setTranslations([{ locale: "es", address, text: "Nombre completo" }])).toBe(1);
    expect(entry(ctrl, "es", address)).toEqual({ text: "Nombre completo", source: sourceHash("Full name") });
    // A source equal to the current default is the same as none.
    expect(ctrl.setTranslations([{ locale: "es", address, text: "Nombre completo!", source: sourceHash("Full name") }])).toBe(1);
    expect(entry(ctrl, "es", address)?.source).toBe(sourceHash("Full name"));
    // An empty text deletes whatever the source says.
    expect(ctrl.setTranslations([{ locale: "es", address, text: "", source: sourceHash("x") }])).toBe(1);
    expect(entry(ctrl, "es", address)).toBeUndefined();
  });

  it("adds languages and writes their entries as one undo step", () => {
    const ctrl = controller();
    const address = addressOf.component("fullName", "label");
    const codes = () => (ctrl.localization()?.supportedLocales ?? []).map((item) => (typeof item === "string" ? item : item.code));
    const written = ctrl.setTranslations([{ locale: "de", address, text: "Vollständiger Name" }], { addLocales: [{ code: "de", label: "Deutsch" }] });
    expect(written).toBe(1);
    expect(codes()).toEqual(["en", "fr-CA", "es", "de"]);
    expect(entry(ctrl, "de", address)?.text).toBe("Vollständiger Name");
    expect(undoDepth(ctrl)).toBe(1);
    ctrl.undo();
    expect(codes()).toEqual(["en", "fr-CA", "es"]);
    expect(entry(ctrl, "de", address)).toBeUndefined();
    ctrl.redo();
    expect(codes()).toEqual(["en", "fr-CA", "es", "de"]);
    expect(entry(ctrl, "de", address)?.text).toBe("Vollständiger Name");
  });

  it("makes the step even when no entry is written, passes over a code the form has, and brings the source language of a form with none", () => {
    const ctrl = controller();
    expect(ctrl.setTranslations([], { addLocales: [{ code: "de" }, { code: "es" }, { code: "x" }] })).toBe(0);
    expect(ctrl.localization()?.supportedLocales?.length).toBe(4);
    expect(undoDepth(ctrl)).toBe(1);
    const fresh = new BuilderController({ componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    fresh.add("text");
    const id = fresh.snapshot().children!.content![0]!.id;
    fresh.setProperty(id, "label", "Name");
    fresh.setTranslations([{ locale: "fr", address: addressOf.component(id, "label"), text: "Nom" }], { addLocales: [{ code: "fr", sourceLocale: "en" }] });
    expect(fresh.localization()).toMatchObject({ defaultLocale: "en" });
    expect(entry(fresh, "fr", addressOf.component(id, "label"))?.text).toBe("Nom");
  });
});
