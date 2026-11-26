import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  addressOf,
  addressOfPropertyPath,
  copyTranslations,
  isSafeSegment,
  isStale,
  isTranslationEntry,
  listTranslations,
  makeDefaultLocale,
  moveTranslations,
  pruneTranslations,
  readCatalogText,
  readFormTranslations,
  readPrimaryTranslationText,
  readTranslation,
  readTranslationCatalog,
  reconcileTranslation,
  removeLocale,
  renameLocale,
  resolveText,
  sourceHash,
  writeTranslation,
  writeTranslationEntry,
  writeTranslations,
  type FormTranslations,
  type TranslationEdit,
  type TextAddress,
  type TranslationCatalog
} from "../form-engine/core/localization/translations.js";
import { readFormChromeConfiguration, readFormChromePart, readHostChromeConfiguration, chromePartText, resolveRegionParts } from "../form-engine/core/schema/form-chrome.js";
import { readInlineOptions, resolveInlineOptionItems } from "../form-engine/core/schema/inline-options.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;

const LABEL = addressOf.component("fullName", "label");

/** The default-language string an address names in the fixture, read from the definition itself. */
function defaultOf(definition: FormDefinition, address: TextAddress): string | undefined {
  const root = definition.root.configuration as Record<string, unknown>;
  const at = (value: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>((cursor, key) => (cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined), value);
  if (address.kind === "form") {
    return at(root, address.path) as string | undefined;
  }
  if (address.kind === "components") {
    const node = (definition.root.children?.content ?? []).find((child) => child.id === address.owner);
    const configuration = node?.configuration as Record<string, unknown> | undefined;
    if (address.path[0] === "options") {
      const options = (configuration?.options ?? []) as Array<Record<string, string>>;
      return options.find((option) => option.value === address.path[1])?.[address.path[2]!];
    }
    return at(configuration, address.path) as string | undefined;
  }
  if (address.kind === "chrome") {
    const chrome = root.chrome as { header?: Array<Record<string, string>>; footer?: Array<Record<string, string>> };
    const part = [...(chrome.header ?? []), ...(chrome.footer ?? [])].find((entry) => entry.id === address.owner);
    return part?.[address.path[0]!];
  }
  return undefined;
}

describe("sourceHash and guards", () => {
  it("is FNV-1a 32-bit in base 36, as the builder's source tracker computed it", () => {
    expect(sourceHash("")).toBe((0x811c9dc5).toString(36));
    expect(sourceHash("Full name")).toBe(sourceHash("Full name"));
    expect(sourceHash("Full name")).not.toBe(sourceHash("Full Name"));
  });

  it("refuses __proto__, constructor, prototype and the empty string as segments", () => {
    expect(isSafeSegment("label")).toBe(true);
    expect(isSafeSegment("a.b")).toBe(true);
    for (const bad of ["", "__proto__", "constructor", "prototype", 3, undefined]) {
      expect(isSafeSegment(bad)).toBe(false);
    }
  });

  it("recognises an entry by its string text and source", () => {
    expect(isTranslationEntry({ text: "Nom", source: "x" })).toBe(true);
    expect(isTranslationEntry({ text: "Nom" })).toBe(false);
    expect(isTranslationEntry("Nom")).toBe(false);
  });
});

describe("write and read", () => {
  it("writes an entry with the default's fingerprint, and reads it back", () => {
    const map = writeTranslation(undefined, "fr-CA", LABEL, "Nom complet", "Full name");
    expect(map).toEqual({ "fr-CA": { components: { fullName: { label: { text: "Nom complet", source: sourceHash("Full name") } } } } });
    expect(readTranslation(map, "fr-CA", LABEL)).toEqual({ text: "Nom complet", source: sourceHash("Full name") });
    expect(readTranslation(map, "fr", LABEL)).toBeUndefined();
  });

  it("is pure: the input map is left as it was and untouched branches are shared", () => {
    const before = writeTranslation(undefined, "fr-CA", addressOf.form("title"), "Accueil", "Intake");
    const frozen = JSON.parse(JSON.stringify(before)) as FormTranslations;
    const after = writeTranslation(before, "fr-CA", LABEL, "Nom", "Name");
    expect(before).toEqual(frozen);
    expect(after["fr-CA"]!.form).toBe(before["fr-CA"]!.form);
    expect(writeTranslation(after, "fr-CA", LABEL, "Nom", "Name")).toBe(after);
  });

  it("an empty text deletes the entry and drops the parents it leaves empty", () => {
    let map = writeTranslation(undefined, "fr-CA", addressOf.option("contact", "email", "label"), "Courriel", "Email");
    map = writeTranslation(map, "fr-CA", addressOf.form("title"), "Accueil", "Intake");
    map = writeTranslation(map, "fr-CA", addressOf.option("contact", "email", "label"), "", "Email");
    expect(map).toEqual({ "fr-CA": { form: { title: { text: "Accueil", source: sourceHash("Intake") } } } });
    expect(writeTranslation(map, "fr-CA", addressOf.form("title"), "", "Intake")).toEqual({});
  });

  it("refuses an unsafe locale, owner or segment and returns the map unchanged", () => {
    const map = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    expect(writeTranslation(map, "__proto__", LABEL, "x", "Name")).toBe(map);
    expect(writeTranslation(map, "fr", addressOf.component("constructor", "label"), "x", "Name")).toBe(map);
    expect(writeTranslation(map, "fr", addressOf.option("contact", "__proto__", "label"), "x", "Name")).toBe(map);
    expect(writeTranslation(map, "fr", { kind: "components", path: ["label"] }, "x", "Name")).toBe(map);
    expect(writeTranslation(map, "fr", { kind: "form", owner: "x", path: ["title"] }, "x", "Name")).toBe(map);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readTranslation(map, "fr", addressOf.component("constructor", "label"))).toBeUndefined();
  });

  it("never reads an inherited property as a translation", () => {
    const map = writeTranslation(undefined, "fr", addressOf.option("c", "email", "label"), "Courriel", "Email");
    expect(readTranslation(map, "fr", addressOf.option("c", "toString", "label"))).toBeUndefined();
    expect(resolveText("Fallback", addressOf.option("c", "hasOwnProperty", "label"), "fr", { translations: map })).toBe("Fallback");
  });

  it("will not write an entry where a tree stands, nor through an entry", () => {
    const map = writeTranslation(undefined, "fr", addressOf.option("c", "email", "label"), "Courriel", "Email");
    expect(writeTranslation(map, "fr", { kind: "components", owner: "c", path: ["options"] }, "x", "y")).toBe(map);
    const withLabel = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    expect(writeTranslation(withLabel, "fr", { kind: "components", owner: "fullName", path: ["label", "x"] }, "x", "y")).toBe(withLabel);
  });

  it("writeTranslationEntry keeps the given source, so a stale clipboard entry stays stale", () => {
    const entry = { text: "Nom", source: sourceHash("Old wording") };
    const map = writeTranslationEntry(undefined, "fr", LABEL, entry);
    expect(readTranslation(map, "fr", LABEL)).toEqual(entry);
    expect(isStale(readTranslation(map, "fr", LABEL)!, "Name")).toBe(true);
    // The entry is copied, not shared with the caller's object.
    expect(readTranslation(map, "fr", LABEL)).not.toBe(entry);
    expect(writeTranslationEntry(map, "fr", LABEL, { ...entry })).toBe(map);
    const replaced = writeTranslationEntry(map, "fr", LABEL, { text: "Nom complet", source: sourceHash("Name") });
    expect(readTranslation(replaced, "fr", LABEL)).toEqual({ text: "Nom complet", source: sourceHash("Name") });
    expect(readTranslation(map, "fr", LABEL)).toEqual(entry);
  });

  it("writeTranslationEntry is guarded like writeTranslation", () => {
    const entry = { text: "Nom", source: "abc" };
    const map = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    expect(writeTranslationEntry(map, "__proto__", LABEL, entry)).toBe(map);
    expect(writeTranslationEntry(map, "fr", addressOf.component("constructor", "label"), entry)).toBe(map);
    expect(writeTranslationEntry(map, "fr", { kind: "components", path: ["label"] }, entry)).toBe(map);
    expect(writeTranslationEntry(map, "fr", { kind: "components", owner: "fullName", path: ["label", "x"] }, entry)).toBe(map);
    expect(writeTranslationEntry(map, "fr", LABEL, { text: "", source: "abc" })).toBe(map);
    expect(writeTranslationEntry(map, "fr", LABEL, { text: 4, source: "abc" } as never)).toBe(map);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("resolveText", () => {
  const map: FormTranslations = {
    "fr-CA": { components: { fullName: { label: { text: "map fr-CA", source: "s" } } } },
    fr: { components: { fullName: { label: { text: "map fr", source: "s" } } } }
  };
  const catalog: TranslationCatalog = {
    "fr-CA": { components: { fullName: { label: "catalog fr-CA" } } },
    fr: { components: { fullName: { label: "catalog fr" } } }
  };

  it("takes the catalog's exact locale over the map's", () => {
    expect(resolveText("Full name", LABEL, "fr-CA", { translations: map, catalog })).toBe("catalog fr-CA");
  });

  it("takes the map's exact locale over the catalog's primary subtag", () => {
    expect(resolveText("Full name", LABEL, "fr-CA", { translations: map, catalog: { fr: catalog.fr! } })).toBe("map fr-CA");
  });

  it("takes the catalog's primary subtag over the map's", () => {
    expect(resolveText("Full name", LABEL, "fr-BE", { translations: map, catalog })).toBe("catalog fr");
    expect(resolveText("Full name", LABEL, "fr-BE", { translations: map })).toBe("map fr");
  });

  it("serves fr-CA from a map that has only fr", () => {
    expect(resolveText("Full name", LABEL, "fr-CA", { translations: { fr: map.fr! } })).toBe("map fr");
  });

  it("matches fr_ca and FR-CA to fr-CA", () => {
    expect(resolveText("Full name", LABEL, "fr_ca", { translations: map })).toBe("map fr-CA");
    expect(resolveText("Full name", LABEL, "FR-CA", { translations: map })).toBe("map fr-CA");
    expect(resolveText("Full name", LABEL, "fr-ca", { catalog: { FR_CA: { components: { fullName: { label: "cat" } } } } })).toBe("cat");
  });

  it("falls through an empty catalog string to the next candidate", () => {
    const empty: TranslationCatalog = { "fr-CA": { components: { fullName: { label: "" } } } };
    expect(resolveText("Full name", LABEL, "fr-CA", { translations: map, catalog: empty })).toBe("map fr-CA");
  });

  it("returns the default last, and when there are no sources", () => {
    expect(resolveText("Full name", LABEL, "de", { translations: map, catalog })).toBe("Full name");
    expect(resolveText("Full name", LABEL, "fr", {})).toBe("Full name");
  });

  it("resolves a stale entry: staleness is the author's concern", () => {
    const stale = writeTranslation(undefined, "fr", LABEL, "Nom", "Old wording");
    expect(resolveText("New wording", LABEL, "fr", { translations: stale })).toBe("Nom");
  });

  it("reads the catalog by its locale spelled any way", () => {
    expect(readCatalogText(catalog, "FR_ca", LABEL)).toBe("catalog fr-CA");
    expect(readCatalogText(catalog, "de", LABEL)).toBeUndefined();
  });
});

describe("staleness", () => {
  it("a written entry is fresh", () => {
    const map = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    expect(isStale(readTranslation(map, "fr", LABEL)!, "Name")).toBe(false);
  });

  it("changing the default makes it stale", () => {
    const map = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    expect(isStale(readTranslation(map, "fr", LABEL)!, "Full name")).toBe(true);
  });

  it("reconcileTranslation clears it without touching the text", () => {
    const map = writeTranslation(undefined, "fr", LABEL, "Nom", "Name");
    const reconciled = reconcileTranslation(map, "fr", LABEL, "Full name");
    expect(readTranslation(reconciled, "fr", LABEL)).toEqual({ text: "Nom", source: sourceHash("Full name") });
    expect(reconcileTranslation(reconciled, "fr", LABEL, "Full name")).toBe(reconciled);
    expect(reconcileTranslation(reconciled, "fr", addressOf.component("other", "label"), "x")).toBe(reconciled);
  });
});

describe("prune, copy and move", () => {
  const base = (): FormTranslations => {
    let map: FormTranslations = {};
    for (const locale of ["fr", "es"]) {
      map = writeTranslation(map, locale, addressOf.component("contact", "label"), `${locale} contact`, "Contact");
      map = writeTranslation(map, locale, addressOf.option("contact", "email", "label"), `${locale} email`, "Email");
      map = writeTranslation(map, locale, addressOf.option("contact", "email", "description"), `${locale} email d`, "Email d");
      map = writeTranslation(map, locale, addressOf.option("contact", "phone", "label"), `${locale} phone`, "Phone");
      map = writeTranslation(map, locale, addressOf.message("contact", "required"), `${locale} required`, "Required");
      map = writeTranslation(map, locale, addressOf.component("other", "label"), `${locale} other`, "Other");
    }
    return map;
  };

  it("prunes an owner in every locale", () => {
    const map = pruneTranslations(base(), { kind: "components", owner: "contact" });
    expect(listTranslations(map).map((row) => `${row.locale}:${row.address.owner}`)).toEqual(["fr:other", "es:other"]);
  });

  it("prunes an option by its prefix, leaving its siblings", () => {
    const map = pruneTranslations(base(), { kind: "components", owner: "contact", path: ["options", "email"] });
    expect(readTranslation(map, "fr", addressOf.option("contact", "email", "label"))).toBeUndefined();
    expect(readTranslation(map, "es", addressOf.option("contact", "email", "description"))).toBeUndefined();
    expect(readTranslation(map, "fr", addressOf.option("contact", "phone", "label"))?.text).toBe("fr phone");
  });

  it("prunes a message and drops the messages level it empties", () => {
    const map = pruneTranslations(base(), { kind: "components", owner: "contact", path: ["messages", "required"] });
    expect(map.fr!.components!.contact!.messages).toBeUndefined();
    expect(pruneTranslations(map, { kind: "components", owner: "absent" })).toBe(map);
  });

  it("copies an owner's tree under a new id in every locale", () => {
    const map = copyTranslations(base(), "components", "contact", "contact_copy");
    expect(readTranslation(map, "es", addressOf.option("contact_copy", "phone", "label"))?.text).toBe("es phone");
    expect(map.fr!.components!.contact_copy).toEqual(map.fr!.components!.contact);
    expect(map.fr!.components!.contact_copy).not.toBe(map.fr!.components!.contact);
  });

  it("moves an owner on an id rename", () => {
    const map = moveTranslations(base(), { kind: "components", owner: "contact" }, { kind: "components", owner: "reach" });
    expect(map.fr!.components!.contact).toBeUndefined();
    expect(readTranslation(map, "fr", addressOf.message("reach", "required"))?.text).toBe("fr required");
  });

  it("moves an option's texts on a value rename", () => {
    const map = moveTranslations(
      base(),
      { kind: "components", owner: "contact", path: ["options", "email"] },
      { kind: "components", owner: "contact", path: ["options", "e.mail"] }
    );
    expect(readTranslation(map, "fr", addressOf.option("contact", "e.mail", "label"))?.text).toBe("fr email");
    expect(readTranslation(map, "fr", addressOf.option("contact", "email", "label"))).toBeUndefined();
  });
});

describe("locales", () => {
  const map: FormTranslations = {
    fr: { form: { title: { text: "Titre", source: sourceHash("Title") } } },
    es: { form: { title: { text: "Título", source: sourceHash("Title") } } }
  };

  it("removeLocale deletes the language's key", () => {
    expect(removeLocale(map, "fr")).toEqual({ es: map.es });
    expect(removeLocale(map, "de")).toBe(map);
  });

  it("renameLocale renames the key in place", () => {
    const renamed = renameLocale(map, "fr", "fr-CA");
    expect(Object.keys(renamed)).toEqual(["fr-CA", "es"]);
    expect(renamed["fr-CA"]).toBe(map.fr);
    expect(renameLocale(map, "fr", "__proto__")).toBe(map);
  });

  it("removeLocale, renameLocale and the walkers neither walk nor copy a __proto__ locale key", () => {
    const loaded = JSON.parse(
      '{"__proto__":{"form":{"title":{"text":"x","source":"s"}}},"fr":{"form":{"title":{"text":"Titre","source":"s"}}},"es":{"form":{"title":{"text":"T","source":"s"}}}}'
    ) as FormTranslations;
    const hasProtoKey = (value: object): boolean => Object.keys(value).includes("__proto__");
    const removed = removeLocale(loaded, "es");
    expect(Object.keys(removed)).toEqual(["fr"]);
    expect(Object.getPrototypeOf(removed)).toBe(Object.prototype);
    const renamed = renameLocale(loaded, "fr", "fr-CA");
    expect(Object.keys(renamed)).toEqual(["fr-CA", "es"]);
    expect(Object.getPrototypeOf(renamed)).toBe(Object.prototype);
    // eachLocale (through prune and copy): the unsafe key is dropped, never assigned.
    const pruned = pruneTranslations(loaded, { kind: "form" });
    expect(hasProtoKey(pruned)).toBe(false);
    expect(Object.getPrototypeOf(pruned)).toBe(Object.prototype);
    expect(Object.keys(pruned)).toEqual([]);
    const moved = moveTranslations(
      JSON.parse('{"__proto__":{"components":{"a":{"label":{"text":"x","source":"s"}}}},"fr":{"components":{"a":{"label":{"text":"A","source":"s"}}}}}') as FormTranslations,
      { kind: "components", owner: "a" },
      { kind: "components", owner: "b" }
    );
    expect(Object.keys(moved)).toEqual(["fr"]);
    expect(Object.getPrototypeOf(moved)).toBe(Object.prototype);
    expect(readTranslation(moved, "fr", addressOf.component("b", "label"))?.text).toBe("A");
  });

  describe("makeDefaultLocale", () => {
    const title = addressOf.form("title");
    const label = LABEL;
    const help = addressOf.chrome("help", "text");
    const texts = [
      { address: title, default: "Customer intake" },
      { address: label, default: "Full name" },
      { address: help, default: "Need help?" }
    ];
    // fr covers the title and the label; es covers the label only; help has no translation at all.
    let start: FormTranslations = {};
    start = writeTranslation(start, "fr", title, "Accueil des clients", "Customer intake");
    start = writeTranslation(start, "fr", label, "Nom complet", "Full name");
    start = writeTranslation(start, "es", label, "Nombre completo", "Full name");

    it("promotes the new language's text, moves the old default under the old code, keeps uncovered texts", () => {
      const { translations, defaults } = makeDefaultLocale(start, texts, "en", "fr");
      expect(defaults).toEqual([
        { address: title, default: "Accueil des clients" },
        { address: label, default: "Nom complet" },
        { address: help, default: "Need help?" }
      ]);
      expect(translations.fr).toBeUndefined();
      expect(readTranslation(translations, "en", title)).toEqual({ text: "Customer intake", source: sourceHash("Accueil des clients") });
      expect(readTranslation(translations, "en", help)).toBeUndefined();
      // The Spanish label still answers the same meaning, so it stays current.
      expect(isStale(readTranslation(translations, "es", label)!, "Nom complet")).toBe(false);
    });

    it("run twice, back and forth, restores the defaults and the map", () => {
      const once = makeDefaultLocale(start, texts, "en", "fr");
      const twice = makeDefaultLocale(once.translations, once.defaults, "fr", "en");
      expect(twice.defaults).toEqual(texts);
      expect(twice.translations).toEqual(start);
    });

    it("leaves an entry that was already stale stale", () => {
      const stale = writeTranslation(start, "es", title, "Título", "An older title");
      const { translations } = makeDefaultLocale(stale, texts, "en", "fr");
      expect(isStale(readTranslation(translations, "es", title)!, "Accueil des clients")).toBe(true);
    });

    it("keeps a promoted entry that was stale stale: the demoted default carries the older source", () => {
      // fr translated an earlier "Customer form"; the default has since become "Customer intake".
      const stalePromoted = writeTranslation(start, "fr", title, "Formulaire client", "Customer form");
      const olderSource = sourceHash("Customer form");
      const { translations, defaults } = makeDefaultLocale(stalePromoted, texts, "en", "fr");
      expect(defaults[0]).toEqual({ address: title, default: "Formulaire client" });
      const demoted = readTranslation(translations, "en", title)!;
      expect(demoted.text).toBe("Customer intake");
      expect(demoted.source).toBe(olderSource);
      expect(isStale(demoted, "Formulaire client")).toBe(true);
      // A promoted entry that was current still comes out current.
      const current = makeDefaultLocale(stalePromoted, texts, "en", "fr").translations;
      expect(isStale(readTranslation(current, "en", label)!, "Nom complet")).toBe(false);
      // Swapping back restores the stale source exactly.
      const back = makeDefaultLocale(translations, defaults, "fr", "en");
      expect(back.defaults).toEqual(texts);
      expect(back.translations).toEqual(stalePromoted);
    });
  });
});

describe("listTranslations", () => {
  it("lists every entry with its address, or one locale's", () => {
    let map = writeTranslation(undefined, "fr", addressOf.formMessage("required"), "Requis", "Required");
    map = writeTranslation(map, "fr", addressOf.journeyPage("apply", "start", "title"), "Début", "Start");
    map = writeTranslation(map, "es", addressOf.pdf("copy", ["name"]), "Copia", "Copy");
    expect(listTranslations(map)).toEqual([
      { locale: "fr", address: { kind: "form", path: ["messages", "required"] }, entry: { text: "Requis", source: sourceHash("Required") } },
      { locale: "fr", address: { kind: "journeys", owner: "apply", path: ["pages", "start", "title"] }, entry: { text: "Début", source: sourceHash("Start") } },
      { locale: "es", address: { kind: "pdf", owner: "copy", path: ["name"] }, entry: { text: "Copia", source: sourceHash("Copy") } }
    ]);
    expect(listTranslations(map, "es")).toHaveLength(1);
    expect(listTranslations(map, "de")).toEqual([]);
  });
});

describe("addressOfPropertyPath", () => {
  const node: ComponentNode = {
    id: "contact",
    type: "select",
    configuration: { label: "Contact", options: [{ value: "email", label: "Email" }, { value: "a.b", label: "Dotted" }] }
  };
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {
      title: "Intake",
      chrome: {
        header: [{ id: "welcome", type: "heading", text: "Hi" }, { id: "row", type: "group", parts: [{ id: "logo", type: "image", src: "a.png", alt: "Logo" }] }],
        footer: [{ id: "help", type: "text", text: "Help" }, { type: "text", text: "No id" }]
      }
    }
  };

  it("names a component's own property", () => {
    expect(addressOfPropertyPath(node, "label", false)).toEqual(addressOf.component("contact", "label"));
  });

  it("names the note printed beside a hidden field, nested under the component's id", () => {
    expect(addressOfPropertyPath(node, "print.note", false)).toEqual({ kind: "components", owner: "contact", path: ["print", "note"] });
    expect(addressOfPropertyPath(root, "print.note", true)).toBeUndefined();
  });

  it("names a printed form's header and footer slots on the root only", () => {
    expect(addressOfPropertyPath(root, "print.header.start", true)).toEqual({ kind: "form", path: ["print", "header", "start"] });
    expect(addressOfPropertyPath(root, "print.footer.end", true)).toEqual(addressOf.printSlot("footer", "end"));
    expect(addressOfPropertyPath(root, "print.margin.start", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "print.header.middle", true)).toBeUndefined();
    expect(addressOfPropertyPath(node, "print.header.start", false)).toBeUndefined();
  });

  it("names a tab's caption by the tab's id, and a step's label as any property", () => {
    const tabs: ComponentNode = {
      id: "sections",
      type: "tabs",
      configuration: { tabs: [{ id: "personal", label: "Personal" }, { id: "work", label: "Work" }, { label: "No id" }] }
    };
    expect(addressOfPropertyPath(tabs, "tabs.1.label", false)).toEqual({ kind: "components", owner: "sections", path: ["tabs", "work", "label"] });
    expect(addressOfPropertyPath(tabs, "tabs.2.label", false)).toBeUndefined();
    expect(addressOfPropertyPath(tabs, "tabs.5.label", false)).toBeUndefined();
    expect(addressOfPropertyPath(tabs, "tabs.0.id", false)).toBeUndefined();
    expect(addressOfPropertyPath(tabs, "tabs", false)).toBeUndefined();
    const step: ComponentNode = { id: "about", type: "step", configuration: { label: "About you" } };
    expect(addressOfPropertyPath(step, "label", false)).toEqual(addressOf.component("about", "label"));
  });

  it("names an option by its value, never its index, a dotted value included", () => {
    expect(addressOfPropertyPath(node, "options.0.label", false)).toEqual(addressOf.option("contact", "email", "label"));
    expect(addressOfPropertyPath(node, "options.1.description", false)).toEqual({ kind: "components", owner: "contact", path: ["options", "a.b", "description"] });
  });

  it("returns undefined for an out-of-range or malformed index, or a non-text option property", () => {
    expect(addressOfPropertyPath(node, "options.2.label", false)).toBeUndefined();
    expect(addressOfPropertyPath(node, "options.01.label", false)).toBeUndefined();
    expect(addressOfPropertyPath(node, "options.0.value", false)).toBeUndefined();
    expect(addressOfPropertyPath(node, "options", false)).toBeUndefined();
    expect(addressOfPropertyPath(node, "print.label", false)).toBeUndefined();
  });

  it("names a message by its code, everything after messages. being the code", () => {
    expect(addressOfPropertyPath(node, "messages.required", false)).toEqual(addressOf.message("contact", "required"));
    expect(addressOfPropertyPath(node, "messages.option.tooMany", false)).toEqual(addressOf.message("contact", "option.tooMany"));
    expect(addressOfPropertyPath(node, "messages.", false)).toBeUndefined();
  });

  it("on the root, names the form's own texts and messages", () => {
    expect(addressOfPropertyPath(root, "title", true)).toEqual(addressOf.form("title"));
    expect(addressOfPropertyPath(root, "description", true)).toEqual(addressOf.form("description"));
    expect(addressOfPropertyPath(root, "messages.required", true)).toEqual(addressOf.formMessage("required"));
  });

  it("on the root, names a chrome part's text by the part's id, inside a group too", () => {
    expect(addressOfPropertyPath(root, "chrome.header.0.text", true)).toEqual(addressOf.chrome("welcome", "text"));
    expect(addressOfPropertyPath(root, "chrome.header.1.parts.0.alt", true)).toEqual(addressOf.chrome("logo", "alt"));
    expect(addressOfPropertyPath(root, "chrome.footer.0.text", true)).toEqual(addressOf.chrome("help", "text"));
  });

  it("returns undefined for a chrome part out of range, without an id, or a region that is not one", () => {
    expect(addressOfPropertyPath(root, "chrome.header.5.text", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "chrome.footer.1.text", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "chrome.aside.0.text", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "chrome.header.1.parts.3.alt", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "chrome.header.0.level", true)).toBeUndefined();
    expect(addressOfPropertyPath(root, "chrome.header.1.parts", true)).toBeUndefined();
  });

  it("keeps component ids that look like kinds apart, and refuses constructor", () => {
    let map: FormTranslations = {};
    for (const id of ["form", "chrome", "pdf", "components"]) {
      const address = addressOfPropertyPath({ id, type: "text", configuration: {} }, "label", false)!;
      expect(address).toEqual({ kind: "components", owner: id, path: ["label"] });
      map = writeTranslation(map, "fr", address, `fr ${id}`, id);
    }
    expect(Object.keys(map.fr!)).toEqual(["components"]);
    expect(resolveText("form", addressOf.component("form", "label"), "fr", { translations: map })).toBe("fr form");
    expect(resolveText("Title", addressOf.form("title"), "fr", { translations: map })).toBe("Title");
    expect(addressOfPropertyPath({ id: "constructor", type: "text", configuration: {} }, "label", false)).toBeUndefined();
  });

  it("keeps an option value with a dot as one segment", () => {
    const map = writeTranslation(undefined, "fr", addressOf.option("contact", "a.b", "label"), "Pointé", "Dotted");
    expect(map.fr!.components!.contact).toEqual({ options: { "a.b": { label: { text: "Pointé", source: sourceHash("Dotted") } } } });
    const items = resolveInlineOptionItems(readInlineOptions(node.configuration), "contact", "fr-CA", { translations: map });
    expect(items).toEqual([
      { value: "email", label: "Email" },
      { value: "a.b", label: "Pointé" }
    ]);
  });
});

describe("tolerant readers", () => {
  it("reads the canonical fixture as it is, and finds no stale entry in it", () => {
    const map = readFormTranslations(fixture.translations);
    expect(map).toEqual(fixture.translations);
    const rows = listTranslations(map);
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const defaultText = defaultOf(fixture, row.address);
      expect(defaultText, JSON.stringify(row.address)).toBeTypeOf("string");
      expect(isStale(row.entry, defaultText!), JSON.stringify(row.address)).toBe(false);
    }
  });

  it("resolves the fixture's texts per locale", () => {
    const sources = { translations: fixture.translations };
    expect(resolveText("Full name", LABEL, "fr", sources)).toBe("Full name");
    expect(resolveText("Full name", LABEL, "fr-CA", sources)).toBe("Nom complet");
    expect(resolveText("Full name", LABEL, "es-MX", sources)).toBe("Nombre completo");
  });

  it("returns undefined for garbage", () => {
    for (const garbage of [undefined, null, 3, "x", [], { fr: "x" }, { fr: { form: "x", components: [] } }]) {
      expect(readFormTranslations(garbage)).toBeUndefined();
    }
  });

  it("prunes unsafe segments, unknown kinds, malformed leaves and empty texts", () => {
    const raw = JSON.parse(`{
      "__proto__": { "form": { "title": { "text": "x", "source": "s" } } },
      "fr": {
        "extra": { "a": { "text": "x", "source": "s" } },
        "form": { "title": { "text": "Titre", "source": "s", "note": "dropped" }, "description": "plain" },
        "components": {
          "constructor": { "label": { "text": "x", "source": "s" } },
          "leaf": { "text": "x", "source": "s" },
          "a": { "label": { "text": "", "source": "s" }, "hint": { "text": "Indice" }, "__proto__": { "text": "x", "source": "s" } },
          "b": { "label": { "text": "Étiquette", "source": "s" } }
        }
      }
    }`) as unknown;
    expect(readFormTranslations(raw)).toEqual({
      fr: {
        form: { title: { text: "Titre", source: "s" } },
        components: { b: { label: { text: "Étiquette", source: "s" } } }
      }
    });
  });

  it("stops at a tree deeper than any address", () => {
    let deep: Record<string, unknown> = { text: "x", source: "s" };
    for (let i = 0; i < 40; i += 1) {
      deep = { level: deep };
    }
    expect(readFormTranslations({ fr: { components: { a: deep } } })).toBeUndefined();
  });

  it("reads a host catalog with string leaves", () => {
    expect(readTranslationCatalog({ fr: { components: { a: { label: "Nom", hint: "", x: 3 } }, chrome: { welcome: { text: "Bonjour" } } } })).toEqual({
      fr: { components: { a: { label: "Nom" } }, chrome: { welcome: { text: "Bonjour" } } }
    });
    expect(readTranslationCatalog("nope")).toBeUndefined();
  });
});

describe("chrome part ids", () => {
  it("readFormChromePart drops a part without a safe id, a group's children included", () => {
    expect(readFormChromePart({ type: "text", text: "Hi" })).toBeUndefined();
    expect(readFormChromePart({ id: "", type: "text", text: "Hi" })).toBeUndefined();
    expect(readFormChromePart({ id: "__proto__", type: "text", text: "Hi" })).toBeUndefined();
    expect(readFormChromePart({ id: "hi", type: "text", text: "Hi" })).toEqual({ id: "hi", type: "text", text: "Hi" });
    expect(readFormChromePart({ id: "row", type: "group", parts: [{ type: "text", text: "a" }, { id: "b", type: "text", text: "b" }] })).toEqual({
      id: "row",
      type: "group",
      parts: [{ id: "b", type: "text", text: "b" }]
    });
  });

  it("reads an authored text only as a string", () => {
    expect(readFormChromePart({ id: "hi", type: "heading", text: { default: "Hi", locales: { fr: "Salut" } } })).toBeUndefined();
  });

  it("host parts need no id and keep LocalizedText, marked as the host's", () => {
    const host = readHostChromeConfiguration({ header: [{ type: "text", text: { default: "Hi", locales: { fr: "Salut" } } }] });
    expect(host?.header).toEqual([{ type: "text", text: { default: "Hi", locales: { fr: "Salut" } }, host: true }]);
    expect(chromePartText(host!.header![0]!, "text", "fr-CA", {})).toBe("Salut");
  });

  it("resolves an authored part's text through the map, and a host-worded switcher as host data", () => {
    const form = readFormChromeConfiguration(fixture.root.configuration);
    const header = resolveRegionParts("header", undefined, form);
    const sources = { translations: fixture.translations };
    expect(header.map((part) => chromePartText(part, part.type === "heading" ? "text" : "label", "fr-CA", sources))).toEqual(["Demander une prestation", "Langue"]);
    const worded = resolveRegionParts("header", { header: [{ type: "language-switcher", label: { default: "Lang", locales: { "fr-CA": "Choix" } }, host: true }] }, form);
    expect(chromePartText(worded[1]!, "label", "fr-CA", sources)).toBe("Choix");
    const hidden = resolveRegionParts("header", { header: [{ type: "language-switcher", hideLabel: true, host: true }] }, form);
    expect(chromePartText(hidden[1]!, "label", "fr-CA", sources)).toBe("Langue");
  });
});

describe("writeTranslations: a bulk write", () => {
  const fr = (id: string, text: string, defaultText: string) => ({ locale: "fr", address: addressOf.component(id, "label"), text, defaultText });

  it("gives what writing the same edits one at a time gives, with the same refusals", () => {
    const start: FormTranslations = {
      fr: { components: { a: { label: { text: "A", source: sourceHash("a") } }, b: { label: { text: "B", source: sourceHash("b") } } } }
    };
    const edits: TranslationEdit[] = [
      fr("a", "A2", "a"),
      fr("c", "C", "c"),
      fr("b", "", "b"),
      { locale: "de", address: addressOf.option("c", "yes", "label"), text: "Ja", defaultText: "Yes" },
      { locale: "fr", address: addressOf.component("d", "label"), text: "D", defaultText: "d", source: "oldsrc" },
      // Refused as `writeTranslation` refuses them: unsafe locale, owner, segment; a leaf where a tree stands; a tree through a leaf.
      { locale: "__proto__", address: addressOf.component("e", "label"), text: "x", defaultText: "e" },
      fr("constructor", "x", "x"),
      { locale: "fr", address: { kind: "components" as const, owner: "a", path: ["label", "deeper"] }, text: "x", defaultText: "x" },
      { locale: "fr", address: { kind: "components" as const, owner: "c" as string, path: ["options"] }, text: "x", defaultText: "x" },
      // Writing what is already there changes nothing.
      fr("a", "A2", "a")
    ];
    let sequential: FormTranslations = start;
    let counted = 0;
    for (const edit of edits) {
      const next =
        edit.source !== undefined && edit.text !== ""
          ? writeTranslationEntry(sequential, edit.locale, edit.address, { text: edit.text, source: edit.source })
          : writeTranslation(sequential, edit.locale, edit.address, edit.text, edit.defaultText);
      if (next !== sequential) {
        counted += 1;
        sequential = next;
      }
    }
    const bulk = writeTranslations(start, edits);
    expect(bulk.translations).toEqual(sequential);
    expect(JSON.stringify(bulk.translations)).toBe(JSON.stringify(sequential));
    expect(bulk.changed).toBe(counted);
    // The input is never mutated, and an edit list that changes nothing gives the map itself back.
    expect(start.fr!.components!.a).toEqual({ label: { text: "A", source: sourceHash("a") } });
    expect(writeTranslations(start, [fr("a", "A", "a")])).toEqual({ translations: start, changed: 0 });
    expect(Object.getPrototypeOf(bulk.translations)).toBe(Object.prototype);
  });

  it("applies 12,000 edits over 4,000 texts in three languages in well under a second", () => {
    const edits = [];
    for (let id = 0; id < 4000; id += 1) {
      for (const locale of ["fr", "es", "de"]) {
        edits.push({ locale, address: addressOf.component(`field_${id}`, "label"), text: `${locale} ${id}`, defaultText: `Field ${id}` });
      }
    }
    const started = performance.now();
    const { translations, changed } = writeTranslations(undefined, edits);
    const elapsed = performance.now() - started;
    expect(changed).toBe(12000);
    expect(Object.keys(translations.fr!.components!)).toHaveLength(4000);
    expect(readTranslation(translations, "de", addressOf.component("field_3999", "label"))?.text).toBe("de 3999");
    // Generous for a loaded CI machine; the per-edit path took seconds at this size.
    expect(elapsed).toBeLessThan(1500);
    // Deleting them all (blank cells in an import) is as cheap, and leaves no empty parents.
    const clearing = edits.map((edit) => ({ ...edit, text: "" }));
    const clearStart = performance.now();
    const cleared = writeTranslations(translations, clearing);
    expect(performance.now() - clearStart).toBeLessThan(1500);
    expect(cleared).toEqual({ translations: {}, changed: 12000 });
  });

  it("drops the parents a deletion empties, and lets a later edit of the batch write where the emptied tree stood", () => {
    const start: FormTranslations = { fr: { components: { c: { options: { yes: { label: { text: "Oui", source: sourceHash("Yes") } } } } } } };
    const edits = [
      { locale: "fr", address: addressOf.option("c", "yes", "label"), text: "", defaultText: "Yes" },
      { locale: "fr", address: { kind: "components" as const, owner: "c", path: ["options", "yes"] }, text: "Entier", defaultText: "Yes" }
    ];
    let sequential: FormTranslations = start;
    for (const edit of edits) {
      sequential = writeTranslation(sequential, edit.locale, edit.address, edit.text, edit.defaultText);
    }
    expect(writeTranslations(start, edits).translations).toEqual(sequential);
    expect(writeTranslations(start, [edits[0]!]).translations).toEqual({});
  });
});

describe("the order of the locale keys across make-default swaps", () => {
  const entry = (text: string, defaultText: string) => ({ text, source: sourceHash(defaultText) });

  it("leaves the saved JSON as it was after swapping to a language and back", () => {
    const start: FormTranslations = {
      "fr-CA": { components: { name: { label: entry("Nom", "Name") } } },
      es: { components: { name: { label: entry("Nombre", "Name") } } }
    };
    const texts = [{ address: addressOf.component("name", "label"), default: "Name" }];
    const there = makeDefaultLocale(start, texts, "en", "fr-CA");
    expect(Object.keys(there.translations)).toEqual(["en", "es"]);
    const back = makeDefaultLocale(there.translations, [{ address: texts[0]!.address, default: there.defaults[0]!.default }], "fr-CA", "en");
    expect(Object.keys(back.translations)).toEqual(["fr-CA", "es"]);
    expect(JSON.stringify(back.translations)).toBe(JSON.stringify(start));
  });

  it("keeps the other languages where they were when the old default is new to the map", () => {
    const start: FormTranslations = {
      es: { components: { name: { label: entry("Nombre", "Name") } } },
      "fr-CA": { components: { name: { label: entry("Nom", "Name") } } },
      de: { components: { name: { label: entry("Name", "Name") } } }
    };
    const texts = [{ address: addressOf.component("name", "label"), default: "Name" }];
    expect(Object.keys(makeDefaultLocale(start, texts, "en", "fr-CA").translations)).toEqual(["es", "en", "de"]);
  });
});

describe("a blank entry is no translation, as the writers read it", () => {
  const label = addressOf.component("name", "label");
  const loaded = { fr: { components: { name: { label: { text: "   ", source: "x" } } } } };

  it("drops a whitespace-only text at load, so no reader serves it", () => {
    expect(readFormTranslations(loaded)).toBeUndefined();
    expect(readTranslationCatalog({ fr: { components: { name: { label: "  " } } } })).toBeUndefined();
    // The text that is kept is not trimmed: the author's spacing stays.
    expect(readFormTranslations({ fr: { components: { name: { label: { text: " Nom ", source: "x" } } } } })?.fr?.components?.name?.label?.text).toBe(" Nom ");
  });

  it("does not promote a blank entry when its language becomes the default", () => {
    const { translations, defaults } = makeDefaultLocale(loaded as FormTranslations, [{ address: label, default: "Full name" }], "en", "fr");
    expect(defaults).toEqual([{ address: label, default: "Full name" }]);
    expect(translations.fr).toEqual(loaded.fr);
  });
});

describe("the form's text under a language's primary subtag", () => {
  const label = addressOf.component("name", "label");
  const map = { fr: { components: { name: { label: { text: "Nom", source: "x" } } } } } as FormTranslations;

  it("is what lookupText reads last, so a regional language shows its base language's text", () => {
    expect(readPrimaryTranslationText(map, "fr-CA", label)).toBe("Nom");
    expect(readPrimaryTranslationText(map, "FR_ca", label)).toBe("Nom");
    expect(resolveText("Name", label, "fr-CA", { translations: map })).toBe("Nom");
  });

  it("is nothing for a primary tag, a base without the text, an unsafe address or no map", () => {
    expect(readPrimaryTranslationText(map, "fr", label)).toBeUndefined();
    expect(readPrimaryTranslationText(map, "es-MX", label)).toBeUndefined();
    expect(readPrimaryTranslationText(map, "fr-CA", addressOf.component("name", "hint"))).toBeUndefined();
    expect(readPrimaryTranslationText(map, "fr-CA", { kind: "components", owner: "__proto__", path: ["label"] })).toBeUndefined();
    expect(readPrimaryTranslationText(undefined, "fr-CA", label)).toBeUndefined();
  });
});
