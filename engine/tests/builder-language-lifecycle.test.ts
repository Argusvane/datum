import { describe, expect, it } from "vitest";

import type { BuilderChangeEvent } from "../form-engine/builder/controller/builder-controller.js";
import type { OutsideDocument } from "../form-engine/core/localization/locale-documents.js";
import { addressOf, readTranslation, writeTranslation, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { languagesController, languagesTranslations } from "./fixtures/builder-languages.js";

/**
 * The language lifecycle across stores: a removal, a
 * rename and a new default move the form's languages, the strings and the one translations map
 * (the journeys' and layouts' texts live in it too) in ONE history entry. The modes' documents
 * are stand-ins here: a block each holding the default strings, written whole.
 */

const THREE = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "de" }], defaultLocale: "en" };

interface Held {
  doc: OutsideDocument;
  state: { value: { title?: string; name?: string; note?: string; layouts?: unknown[] } };
  writes: number;
}

/** A block of default strings, as a mode holds them, written whole as a mode writes its catalog. */
function held(id: "journeys" | "pdf", initial: Held["state"]["value"]): Held {
  const state = { value: initial };
  const out: Held = {
    state,
    writes: 0,
    doc: {
      id,
      read: () => state.value,
      write: (value) => {
        state.value = value as Held["state"]["value"];
        out.writes += 1;
      },
      texts: () => (id === "journeys" ? [{ address: addressOf.journeyPage("apply", "start", "title"), default: state.value.title ?? "" }] : [{ address: addressOf.pdf("copy", ["name"]), default: state.value.name ?? "" }]),
      setDefaults: (value, edits) => {
        const next = { ...(value as Held["state"]["value"]) };
        for (const edit of edits) {
          if (id === "journeys" && edit.address.kind === "journeys") {
            next.title = edit.default;
          }
          if (id === "pdf" && edit.address.kind === "pdf") {
            next.name = edit.default;
          }
        }
        return next;
      }
    }
  };
  return out;
}

/** The codes the form declares, in order. */
const codes = (ctrl: ReturnType<typeof languagesController>): string[] => (ctrl.localization()?.supportedLocales ?? []).map((entry) => (typeof entry === "string" ? entry : entry.code));

const TITLE = addressOf.journeyPage("apply", "start", "title");
const LAYOUT_NAME = addressOf.pdf("copy", ["name"]);

/** The fixture's French, plus a journey page title and a layout name in French and the page title in German. */
function documentTranslations(): FormTranslations {
  let map = languagesTranslations();
  map = writeTranslation(map, "fr", TITLE, "Début", "Start");
  map = writeTranslation(map, "de", TITLE, "Anfang", "Start");
  map = writeTranslation(map, "fr", LAYOUT_NAME, "Copie", "Copy");
  return map;
}

function withDocuments(localization = THREE) {
  const ctrl = languagesController(localization);
  ctrl.replaceTranslations(documentTranslations(), { silent: true });
  const j = held("journeys", { title: "Start", note: "x" });
  const p = held("pdf", { name: "Copy" });
  ctrl.setOutsideDocuments(() => [j.doc, p.doc]);
  return { ctrl, j, p };
}

const entryOf = (ctrl: ReturnType<typeof languagesController>, locale: string, address: Parameters<typeof readTranslation>[2]) => readTranslation(ctrl.translations(), locale, address)?.text;

describe("removing a language across the stores (undo atomicity)", () => {
  const remove = (ctrl: ReturnType<typeof languagesController>, code: string): boolean => ctrl.localizationActions.removeLocale(code);

  it("removes the form's, the journeys' and the layouts' translations in one step, and one Undo puts all back with the language", () => {
    const { ctrl, j, p } = withDocuments();
    const before = { tree: JSON.stringify(ctrl.snapshot()), map: ctrl.translations() };
    expect(remove(ctrl, "fr")).toBe(true);
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBeUndefined();
    expect(entryOf(ctrl, "fr", TITLE)).toBeUndefined();
    expect(entryOf(ctrl, "fr", LAYOUT_NAME)).toBeUndefined();
    expect(entryOf(ctrl, "de", TITLE)).toBe("Anfang");
    // The strings, in the tree and in the modes' blocks, are not touched by a removal.
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
    expect(j.writes + p.writes).toBe(0);
    expect(codes(ctrl)).toEqual(["en", "de"]);

    ctrl.undo();
    expect(JSON.stringify(ctrl.snapshot())).toBe(before.tree);
    expect(ctrl.translations()).toEqual(before.map);
    // The language the translations were written in comes back with them.
    expect(codes(ctrl)).toEqual(["en", "fr", "de"]);
    expect(ctrl.canUndo()).toBe(false);

    ctrl.redo();
    expect(entryOf(ctrl, "fr", LAYOUT_NAME)).toBeUndefined();
    expect(codes(ctrl)).toEqual(["en", "de"]);
  });

  it("takes an Undo back without discarding a translation typed in another language since", () => {
    const { ctrl } = withDocuments();
    remove(ctrl, "fr");
    ctrl.setTranslations([{ locale: "de", address: addressOf.component("name", "label"), text: "Vollständiger Name" }]);
    ctrl.undo();
    ctrl.undo();
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBe("Nom complet");
    expect(entryOf(ctrl, "de", addressOf.component("name", "label"))).toBeUndefined();
  });

  it("spends a step on a removal only the journeys had text for, and one Undo takes it back", () => {
    const { ctrl } = withDocuments();
    remove(ctrl, "de");
    expect(entryOf(ctrl, "de", TITLE)).toBeUndefined();
    expect(ctrl.translations()?.de).toBeUndefined();
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(entryOf(ctrl, "de", TITLE)).toBe("Anfang");
    expect(codes(ctrl)).toEqual(["en", "fr", "de"]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("reports no removed locales on the change event, and spends a step of its own on a language nothing was written in", () => {
    const ctrl = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr" }, { code: "es" }], defaultLocale: "en" });
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    expect(ctrl.localizationActions.removeLocale("es")).toBe(true);
    expect(events.some((event) => "removedLocales" in event)).toBe(false);
    // The language itself is an edit: Undo brings it back (and Redo drops it again).
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr", "es"]);
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "fr"]);
  });
});

describe("renaming a language code", () => {
  it("moves every store's translations to the new code, keeping the label, in one step", () => {
    const { ctrl, j, p } = withDocuments({ ...THREE, defaultLocale: "fr" });
    ctrl.setOptions({ locale: "fr" });
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    const before = { tree: JSON.stringify(ctrl.snapshot()), map: ctrl.translations() };

    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(true);
    expect(entryOf(ctrl, "fr-CA", addressOf.component("name", "label"))).toBe("Nom complet");
    expect(entryOf(ctrl, "fr-CA", addressOf.formMessage("required"))).toBe("Répondez");
    expect(entryOf(ctrl, "fr-CA", addressOf.form("title"))).toBe("Permis");
    expect(entryOf(ctrl, "fr-CA", TITLE)).toBe("Début");
    expect(entryOf(ctrl, "fr-CA", LAYOUT_NAME)).toBe("Copie");
    expect(ctrl.translations()?.fr).toBeUndefined();
    expect(entryOf(ctrl, "de", TITLE)).toBe("Anfang");
    expect(ctrl.localization()).toEqual({ supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français" }, { code: "de" }], defaultLocale: "fr-CA" });
    expect(ctrl.currentLocale()).toBe("fr-CA");
    expect(events.some((event) => "removedLocales" in event)).toBe(false);
    // The modes' blocks hold strings in the default language: a rename leaves them.
    expect(j.writes + p.writes).toBe(0);
    // A host hears of the rename at its Save, not as it happens.
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [{ from: "fr", to: "fr-CA" }] });

    ctrl.undo();
    expect(JSON.stringify(ctrl.snapshot())).toBe(before.tree);
    expect(ctrl.translations()).toEqual(before.map);
    expect(codes(ctrl)).toEqual(["en", "fr", "de"]);
    expect(ctrl.localization()?.defaultLocale).toBe("fr");
    expect(ctrl.currentLocale()).toBe("fr");
    expect(ctrl.canUndo()).toBe(false);
    // Undone before the host saved: nothing is left for it to do.
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    ctrl.redo();
    expect(entryOf(ctrl, "fr-CA", addressOf.component("name", "label"))).toBe("Nom complet");
    expect(ctrl.localization()?.defaultLocale).toBe("fr-CA");
    expect(ctrl.localeChangesSinceSave().renamed).toEqual([{ from: "fr", to: "fr-CA" }]);
  });

  it("refuses a code the form has, a case variant of another, a blank one, an unknown source, and a form with unapplied settings", () => {
    const { ctrl } = withDocuments();
    const tree = JSON.stringify(ctrl.snapshot());
    expect(ctrl.renameLocale("fr", "de")).toBe(false);
    expect(ctrl.renameLocale("fr", "DE")).toBe(false);
    expect(ctrl.renameLocale("fr", "  ")).toBe(false);
    expect(ctrl.renameLocale("fr", "fr")).toBe(false);
    expect(ctrl.renameLocale("es", "es-MX")).toBe(false);
    ctrl.setDraftProperty(ctrl.rootId(), "description", "Not applied");
    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(false);
    ctrl.discardDraft(ctrl.rootId());
    expect(JSON.stringify(ctrl.snapshot())).toBe(tree);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("refuses a code that is not a language code: __proto__, a space inside, a bare digit", () => {
    const { ctrl } = withDocuments();
    const tree = JSON.stringify(ctrl.snapshot());
    const map = JSON.stringify(ctrl.translations());
    const list = JSON.stringify(ctrl.localization());
    for (const code of ["__proto__", "constructor", "fr CA", "f", "12", "fr_CA!"]) {
      expect(ctrl.renameLocale("fr", code), code).toBe(false);
    }
    expect(JSON.stringify(ctrl.snapshot())).toBe(tree);
    expect(JSON.stringify(ctrl.translations())).toBe(map);
    expect(JSON.stringify(ctrl.localization())).toBe(list);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("renames a code nothing is written in as a step of its own, and still counts it for the host's Save", () => {
    const ctrl = languagesController({ supportedLocales: [{ code: "en" }, { code: "es" }], defaultLocale: "en" });
    expect(ctrl.renameLocale("es", "es-MX")).toBe(true);
    expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "es-MX" }]);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [{ from: "es", to: "es-MX" }] });
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "es" }]);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    ctrl.redo();
    expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "es-MX" }]);
  });

  it("carries a change of case: fr-ca becomes fr-CA", () => {
    const ctrl = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr-ca" }], defaultLocale: "en" });
    ctrl.replaceTranslations({ "fr-ca": { components: { name: { label: { text: "Nom", source: "x" } } } } }, { silent: true });
    expect(ctrl.renameLocale("fr-ca", "fr-CA")).toBe(true);
    expect(entryOf(ctrl, "fr-CA", addressOf.component("name", "label"))).toBe("Nom");
    expect(ctrl.translations()?.["fr-ca"]).toBeUndefined();
  });
});

describe("a new default language", () => {
  const makeDefault = (ctrl: ReturnType<typeof languagesController>, code: string): void => {
    expect(ctrl.localizationActions.makeDefaultLocale(code)).toBe(true);
  };

  it("takes the new language's wording as the strings and moves the old strings into the old language's translations, in one step", () => {
    const { ctrl, j, p } = withDocuments();
    const tree = JSON.stringify(ctrl.snapshot());
    const map = ctrl.translations();
    makeDefault(ctrl, "fr");
    expect(ctrl.getProperty("name", "label")).toBe("Nom complet");
    expect(entryOf(ctrl, "en", addressOf.component("name", "label"))).toBe("Full name");
    expect(ctrl.getProperty("root", "title")).toBe("Permis");
    expect(entryOf(ctrl, "en", addressOf.form("title"))).toBe("Permit");
    expect(ctrl.getProperty("kind", "options.0.label")).toBe("Oui");
    expect(entryOf(ctrl, "en", addressOf.option("kind", "yes", "label"))).toBe("Yes");
    expect(j.state.value.title).toBe("Début");
    expect(entryOf(ctrl, "en", TITLE)).toBe("Start");
    expect(entryOf(ctrl, "de", TITLE)).toBe("Anfang");
    expect(p.state.value.name).toBe("Copie");
    expect(entryOf(ctrl, "en", LAYOUT_NAME)).toBe("Copy");
    expect(ctrl.localization()?.defaultLocale).toBe("fr");

    ctrl.undo();
    expect(JSON.stringify(ctrl.snapshot())).toBe(tree);
    expect(ctrl.translations()).toEqual(map);
    expect(ctrl.localization()?.defaultLocale).toBe("en");
    expect(j.state.value.title).toBe("Start");
    expect(p.state.value.name).toBe("Copy");
    expect(ctrl.canUndo()).toBe(false);
  });

  it("keeps the default of a text with no wording in the new language, and invents no entry for the old one", () => {
    const { ctrl } = withDocuments();
    makeDefault(ctrl, "fr");
    // The field's description and the option "No" have only a default: it stays exactly as written.
    expect(ctrl.getProperty("name", "description")).toBe("As on your ID");
    expect(ctrl.getProperty("kind", "options.1.label")).toBe("No");
    expect(ctrl.getProperty("kind", "label")).toBe("Kind");
    expect(entryOf(ctrl, "en", addressOf.component("name", "description"))).toBeUndefined();
  });

  it("changes the default as a step of its own when no text has wording in it", () => {
    const ctrl = languagesController({ supportedLocales: [{ code: "en" }, { code: "es" }], defaultLocale: "en" });
    makeDefault(ctrl, "es");
    expect(ctrl.localization()?.defaultLocale).toBe("es");
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
    expect(ctrl.canUndo()).toBe(true);
    ctrl.undo();
    expect(ctrl.localization()?.defaultLocale).toBe("en");
  });

  it("promotes the first language left when the default language is removed, then drops the old language's wording", () => {
    const { ctrl, j } = withDocuments({ supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } as typeof THREE);
    expect(ctrl.localizationActions.removeLocale("en")).toBe(true);
    expect(ctrl.getProperty("name", "label")).toBe("Nom complet");
    expect(ctrl.getProperty("root", "title")).toBe("Permis");
    expect(ctrl.getProperty("name", "description")).toBe("As on your ID");
    expect(j.state.value.title).toBe("Début");
    expect(ctrl.translations()?.en).toBeUndefined();
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBeUndefined();
    ctrl.undo();
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBe("Nom complet");
    expect(codes(ctrl)).toEqual(["en", "fr"]);
    expect(ctrl.localization()?.defaultLocale).toBe("en");
  });

  it("is not a swap when the old default is not a language the form declares (the first language added)", () => {
    const ctrl = languagesController(null);
    ctrl.setLocalization({ supportedLocales: [{ code: "fr" }], defaultLocale: "fr" });
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBe("Nom complet");
  });
});

describe("Apply across the stores", () => {
  it("writes the form's, the journeys' and the layouts' translations as one undo step", () => {
    const { ctrl } = withDocuments();
    const map = ctrl.translations();
    expect(
      ctrl.setTranslations([
        { locale: "fr", address: addressOf.component("name", "description"), text: "Comme sur votre pièce" },
        { locale: "fr", address: TITLE, text: "Commencer" },
        { locale: "de", address: LAYOUT_NAME, text: "Kopie" }
      ])
    ).toBe(3);
    expect(entryOf(ctrl, "fr", addressOf.component("name", "description"))).toBe("Comme sur votre pièce");
    expect(entryOf(ctrl, "fr", TITLE)).toBe("Commencer");
    expect(entryOf(ctrl, "de", LAYOUT_NAME)).toBe("Kopie");
    ctrl.undo();
    expect(ctrl.translations()).toEqual(map);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("writes nothing when nothing lands", () => {
    const { ctrl } = withDocuments();
    expect(ctrl.setTranslations([])).toBe(0);
    expect(ctrl.setTranslations([{ locale: "fr", address: addressOf.pdf("ghost", ["name"]), text: "x" }])).toBe(0);
    expect(ctrl.canUndo()).toBe(false);
  });
});

describe("an Undo touches only what its entry changed", () => {
  const remove = (ctrl: ReturnType<typeof languagesController>, code: string): void => {
    expect(ctrl.localizationActions.removeLocale(code)).toBe(true);
  };

  it("keeps a language added after the entry: remove fr, add es, Undo gives en, fr (back after en), de, es (after the rest)", () => {
    const ctrl = languagesController(THREE);
    remove(ctrl, "fr");
    // Declared beside the history, as a mode's mirror of the form's languages is: no step of its own.
    ctrl.setLocalization({ ...THREE, supportedLocales: [...(ctrl.localization()?.supportedLocales ?? []), { code: "es" }] as typeof THREE.supportedLocales }, { silent: true });
    expect(codes(ctrl)).toEqual(["en", "de", "es"]);
    ctrl.undo();
    expect(codes(ctrl)).toEqual(["en", "fr", "de", "es"]);
    expect(entryOf(ctrl, "fr", addressOf.component("name", "label"))).toBe("Nom complet");
    ctrl.redo();
    expect(codes(ctrl)).toEqual(["en", "de", "es"]);
  });

  it("keeps a label set after the entry, and the default the author changed since", () => {
    const ctrl = languagesController(THREE);
    remove(ctrl, "fr");
    ctrl.setLocalization({ supportedLocales: [{ code: "en", label: "English" }, { code: "de", label: "Deutsch" }], defaultLocale: "en" }, { silent: true });
    ctrl.undo();
    expect(ctrl.localization()?.supportedLocales).toEqual([{ code: "en", label: "English" }, { code: "fr", label: "Français" }, { code: "de", label: "Deutsch" }]);
  });

  it("puts a journey's wording back although a translation of another page was typed after the removal", () => {
    const { ctrl } = withDocuments();
    remove(ctrl, "fr");
    ctrl.rewriteTranslations((map) => writeTranslation(map, "de", addressOf.journeyPage("apply", "other", "title"), "Anderes", "Other"));
    ctrl.undo();
    ctrl.undo();
    expect(entryOf(ctrl, "fr", TITLE)).toBe("Début");
    expect(entryOf(ctrl, "de", TITLE)).toBe("Anfang");
    expect(entryOf(ctrl, "de", addressOf.journeyPage("apply", "other", "title"))).toBeUndefined();
  });
});

describe("the net language change a host reads at its Save", () => {
  const FOUR = { supportedLocales: [{ code: "en" }, { code: "fr" }, { code: "de" }, { code: "es" }], defaultLocale: "en" };
  const drop = (ctrl: ReturnType<typeof languagesController>, ...gone: string[]): void => {
    for (const code of gone) {
      expect(ctrl.localizationActions.removeLocale(code)).toBe(true);
    }
  };

  it("announces nothing as it happens: a removal's change event no longer asks the host to prune", () => {
    const ctrl = languagesController(FOUR);
    const events: BuilderChangeEvent[] = [];
    ctrl.on("change", (event) => events.push(event));
    drop(ctrl, "fr");
    expect(events.some((event) => "renamedLocales" in event || "removedLocales" in event)).toBe(false);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["fr"], renamed: [] });
  });

  it("collapses a rename chain to one move, and a rename back to nothing", () => {
    const ctrl = languagesController(FOUR);
    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(true);
    expect(ctrl.renameLocale("fr-CA", "fr-QC")).toBe(true);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [{ from: "fr", to: "fr-QC" }] });
    expect(ctrl.renameLocale("fr-QC", "fr")).toBe(true);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
  });

  it("follows Undo and Redo, and a removal brought back by Undo is no change", () => {
    const { ctrl } = withDocuments();
    ctrl.localizationActions.removeLocale("de");
    ctrl.renameLocale("fr", "fr-CA");
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["de"], renamed: [{ from: "fr", to: "fr-CA" }] });
    ctrl.undo();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["de"], renamed: [] });
    ctrl.undo();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    ctrl.redo();
    ctrl.redo();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["de"], renamed: [{ from: "fr", to: "fr-CA" }] });
  });

  it("counts a language added and removed again as nothing, and a rename into a removed code's slot as both (removals first, the moved entry wins)", () => {
    const ctrl = languagesController(FOUR);
    expect(ctrl.localizationActions.addLocale("it")).toBe(true);
    drop(ctrl, "it");
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    // de removed, then fr renamed into the slot: the host drops de's wording, then moves fr's there.
    const next = languagesController(FOUR);
    next.localizationActions.removeLocale("de");
    expect(next.renameLocale("fr", "de")).toBe(true);
    expect(next.localeChangesSinceSave()).toEqual({ removed: ["de"], renamed: [{ from: "fr", to: "de" }] });
  });

  it("starts counting again once the host has saved, and when the host loads another form", () => {
    const ctrl = languagesController(FOUR);
    drop(ctrl, "es");
    ctrl.markLocalesSaved();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    ctrl.undo();
    // The baseline moved to the saved state: the language that came back is new, not a removal undone.
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    ctrl.renameLocale("fr", "fr-CA");
    ctrl.setOptions({ initialRoot: ctrl.snapshot(), localization: ctrl.localization()! });
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
  });

  it("counts from the languages a pending save was handed, and from the old baseline again with both moves when it fails", () => {
    const ctrl = languagesController(FOUR);
    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(true);
    drop(ctrl, "es");
    const failed = ctrl.markLocalesSaving();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
    // Moved while the save is pending: the language renamed again, another removed, one added and renamed.
    expect(ctrl.renameLocale("fr-CA", "fr-QC")).toBe(true);
    drop(ctrl, "de");
    expect(ctrl.localizationActions.addLocale("it")).toBe(true);
    expect(ctrl.renameLocale("it", "it-CH")).toBe(true);
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["de"], renamed: [{ from: "fr-CA", to: "fr-QC" }] });
    failed();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["de", "es"], renamed: [{ from: "fr", to: "fr-QC" }] });
    // An Undo of a removal made before the save still brings the old baseline's language back as no change.
    ctrl.undo();
    ctrl.undo();
    ctrl.undo();
    ctrl.undo();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: ["es"], renamed: [{ from: "fr", to: "fr-CA" }] });
  });

  it("leaves a baseline set again while the save was pending, when the save fails", () => {
    const ctrl = languagesController(FOUR);
    drop(ctrl, "es");
    const failed = ctrl.markLocalesSaving();
    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(true);
    ctrl.markLocalesSaved();
    failed();
    expect(ctrl.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
  });
});

describe("one step's events read a consistent definition and a layout's own language follows a rename", () => {
  it("has the form's languages already changed when a mode's document is written", () => {
    const ctrl = languagesController(THREE);
    const seen: string[][] = [];
    ctrl.replaceTranslations(documentTranslations(), { silent: true });
    const document = held("journeys", { title: "Start" });
    ctrl.setOutsideDocuments(() => [{ ...document.doc, write: () => seen.push(codes(ctrl)) }]);
    // Making fr the default rewrites the journey's string: the document is written inside the step.
    expect(ctrl.localizationActions.makeDefaultLocale("fr")).toBe(true);
    expect(seen[0]).toEqual(["en", "fr", "de"]);
    expect(ctrl.localization()?.defaultLocale).toBe("fr");
  });

  it("renames a PDF layout's document language with the code, and undoes it", () => {
    const ctrl = languagesController(THREE);
    const state = { value: { layouts: [{ id: "copy", name: "Copy", accessibility: { lang: "fr", tagged: true } }, { id: "other", name: "Other", accessibility: { lang: "de" } }] } as unknown };
    ctrl.setOutsideDocuments(() => [{ id: "pdf", read: () => state.value, write: (value) => (state.value = value), texts: () => [], setDefaults: (value) => value }]);
    expect(ctrl.renameLocale("fr", "fr-CA")).toBe(true);
    const layouts = (state.value as { layouts: Array<{ accessibility: { lang: string } }> }).layouts;
    expect(layouts.map((layout) => layout.accessibility.lang)).toEqual(["fr-CA", "de"]);
    ctrl.undo();
    expect((state.value as { layouts: Array<{ accessibility: { lang: string } }> }).layouts.map((layout) => layout.accessibility.lang)).toEqual(["fr", "de"]);
  });
});
