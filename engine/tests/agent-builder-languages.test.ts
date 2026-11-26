import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderController, LeaveGuard } from "../form-engine/builder/controller/builder-controller.js";
import { addressOf, readTranslation, sourceHash } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS } from "./fixtures/agent-builder-definitions.js";
import { documentController } from "./fixtures/agent-builder-documents-fakes.js";
import { languagesBuilder, withOutsideJourney, withOutsidePdfName, type LanguagesBuilder } from "./fixtures/agent-builder-languages-fakes.js";
import { jsonByteLength } from "../form-engine/agent/result-caps.js";
import { okOf, refusalOf } from "./fixtures/agent-builder.js";
import { LANGUAGES, languagesRoot, languagesTranslations } from "./fixtures/builder-languages.js";

/**
 * The `languages` tool's body over the
 * shared Languages fixture: the rows and the coverage as the workspace counts them, `add` with
 * the source language declared first (never a guessed `en`) and the same-label no-op,
 * `rename` / `relabel` / `set_default` as one step each (the controller's language actions move
 * the languages and the translations map together), `translate` across every group in
 * one `setTranslations` step (the default language is the text itself, never a translation), the
 * person's state first, `preview` without a step, the 512 KB input, and the
 * interleaved Undo all with a `documents` write.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const JSON_OF = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function languages(set: LanguagesBuilder, input: Record<string, unknown>): ReturnType<LanguagesBuilder["builder"]["execute"]> {
  return set.builder.execute("languages", input);
}

function guard(id: string): LeaveGuard {
  return { pending: () => true, subject: () => ({ id, label: id, blocked: false }), save: () => true, discard: () => undefined };
}

/** The ids of every text the tool lists for `input`. */
async function textIds(set: LanguagesBuilder, input: Record<string, unknown> = {}): Promise<string[]> {
  const result = okOf<{ texts: Array<{ textId: string }> }>(await languages(set, { action: "texts", ...input }));
  return result.texts.map((entry) => entry.textId);
}

/** A step count the history reports: how many undos the controller can still make. */
function undoDepth(controller: BuilderController): number {
  let depth = 0;
  while (controller.canUndo()) {
    controller.undo();
    depth += 1;
  }
  for (let step = 0; step < depth; step += 1) {
    controller.redo();
  }
  return depth;
}

/** The Languages fixture with extra text fields (id and label), over a controller the tool can write. */
async function withFields(ids: string[]): Promise<LanguagesBuilder> {
  const root: ComponentNode = languagesRoot();
  const content = root.children?.content as ComponentNode[];
  const translations = languagesTranslations();
  for (const id of ids) {
    content.push({ id, type: "text", configuration: { label: `Label ${id}` } });
    translations.fr!.components![id] = { label: { text: `Étiquette ${id}`, source: sourceHash(`Label ${id}`) } };
  }
  const { BuilderController: Controller } = await import("../form-engine/builder/controller/builder-controller.js");
  const controller = new Controller({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS, localization: LANGUAGES, translations });
  return languagesBuilder({ controller });
}

/** The French wording of a text in the controller's map, as the tool wrote it. */
function frenchOf(controller: BuilderController, address: Parameters<typeof readTranslation>[2], locale = "fr"): string | undefined {
  return readTranslation(controller.translations(), locale, address)?.text;
}

describe("list and texts: the rows as the Languages workspace counts them", () => {
  it("lists the languages with the default, the preview language and how much of each is translated", async () => {
    const set = languagesBuilder();
    const listed = okOf(await languages(set, { action: "list" }));
    expect(listed).toMatchObject({
      tool: "languages",
      action: "list",
      changed: false,
      declared: true,
      defaultLanguage: "en",
      previewLanguage: "en",
      languages: [
        { code: "en", label: "English", isDefault: true, translated: 11, total: 11 },
        { code: "fr", label: "Français", isDefault: false, translated: 4, total: 11 }
      ],
      outside: { journeys: "none", pdf: "none" },
      next: ["languages { action: 'texts', missingOnly: true } lists what is not translated yet."]
    });
    expect(listed).not.toHaveProperty("undo");
    expect(listed).not.toHaveProperty("texts");
  });

  it("answers declared: false with no languages and says how to declare one", async () => {
    const set = languagesBuilder({ localization: null });
    const listed = okOf(await languages(set, { action: "list" }));
    expect(listed).toMatchObject({ declared: false, defaultLanguage: "en", languages: [], next: ["languages { action: 'add', code, sourceLocale } declares the form's language and a new one."] });
  });

  it("counts a journey's name as a row when the page lends it, and names a side it could not reach", async () => {
    const set = languagesBuilder();
    withOutsideJourney(set);
    const listed = okOf(await languages(set, { action: "list" }));
    expect(listed.outside).toEqual({ journeys: "included", pdf: "none" });
    // The header's heading is the controller's own row (the form's texts), the journey's name the page's.
    expect((listed.languages as Array<{ total: number }>)[0]?.total).toBe(12);
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, extraTexts: [], notLoaded: ["pdf"] };
    expect(okOf(await languages(set, { action: "list" })).outside).toEqual({ journeys: "none", pdf: "not-loaded" });
  });

  it("lists every text with a textId, its source and its translations, in the workspace's order", async () => {
    const set = languagesBuilder();
    const listed = okOf<{ texts: Array<Record<string, unknown>>; textCount: number }>(await languages(set, { action: "texts" }));
    expect(listed.textCount).toBe(11);
    expect(listed.texts.map((entry) => entry.textId)).toEqual([
      "fields|form/title",
      "fields|components/name/label",
      "fields|components/name/description",
      "fields|components/kind/label",
      "options|components/kind/options/yes/label",
      "options|components/kind/options/no/label",
      "options|components/kind/options/no/description",
      "messages|form/messages/required",
      "messages|form/messages/journey.exit",
      "messages|components/name/messages/required",
      "chrome|chrome/welcome/text"
    ]);
    expect(listed.texts[1]).toEqual({ textId: "fields|components/name/label", group: "fields", componentId: "name", component: "Full name", what: "Label", source: "Full name", translations: { fr: "Nom complet" }, writable: true });
    expect(listed).toMatchObject({ next: ["Write translations with languages { action: 'translate' } by textId and language."] });
  });

  it("filters to what is missing in a language, one group, or a search; the default language has no translation cell", async () => {
    const set = languagesBuilder();
    expect(await textIds(set, { language: "fr", missingOnly: true })).toEqual([
      "fields|components/name/description",
      "fields|components/kind/label",
      "options|components/kind/options/no/label",
      "options|components/kind/options/no/description",
      "messages|form/messages/journey.exit",
      "messages|components/name/messages/required",
      "chrome|chrome/welcome/text"
    ]);
    // Without a language: missing in any language the form declares besides the source one.
    expect(await textIds(set, { missingOnly: true })).toHaveLength(7);
    // Every row has wording in the default language, so none is missing there.
    expect(await textIds(set, { language: "en", missingOnly: true })).toEqual([]);
    expect(await textIds(set, { group: "options" })).toEqual(["options|components/kind/options/yes/label", "options|components/kind/options/no/label", "options|components/kind/options/no/description"]);
    expect(await textIds(set, { search: "nom complet" })).toEqual(["fields|components/name/label"]);
    const french = okOf<{ texts: Array<{ textId: string; translations: Record<string, string> }> }>(await languages(set, { action: "texts", language: "fr", group: "fields" }));
    expect(french.texts.map((entry) => entry.translations)).toEqual([{ fr: "Permis" }, { fr: "Nom complet" }, {}, {}]);
  });

  it("refuses an undeclared language to filter by, with the languages there are", async () => {
    const set = languagesBuilder();
    expect(refusalOf(await languages(set, { action: "texts", language: "de" }))).toMatchObject({
      code: "locale-unsupported",
      retryable: false,
      details: { locale: "de", supported: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }
    });
  });

  it("pages with offset and limit, and says where the next page starts", async () => {
    const set = languagesBuilder();
    const first = okOf<{ texts: unknown[]; textCount: number; truncated?: true; nextOffset?: number; next: string[] }>(await languages(set, { action: "texts", limit: 4 }));
    expect(first.texts).toHaveLength(4);
    expect(first).toMatchObject({ textCount: 11, truncated: true, nextOffset: 4, next: ["Call again with offset: 4."] });
    const last = okOf<{ texts: unknown[] }>(await languages(set, { action: "texts", offset: 8, limit: 4 }));
    expect(last.texts).toHaveLength(3);
    expect(last).not.toHaveProperty("truncated");
  });

  it("keeps a page under the result cap on a form of 3000 texts, and pages through all of them", async () => {
    const root: ComponentNode = languagesRoot();
    const content = root.children?.content as ComponentNode[];
    const translations = languagesTranslations();
    for (let index = 0; index < 3000; index += 1) {
      const label = `Question number ${index} with a fairly long label so a page weighs something`;
      content.push({ id: `q${index}`, type: "text", configuration: { label } });
      translations.fr!.components![`q${index}`] = { label: { text: `Question numéro ${index} avec une étiquette assez longue`, source: sourceHash(label) } };
    }
    const { BuilderController: Controller } = await import("../form-engine/builder/controller/builder-controller.js");
    const controller = new Controller({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS, localization: LANGUAGES, translations });
    const set = languagesBuilder({ controller });
    let offset = 0;
    let pages = 0;
    const seen = new Set<string>();
    for (;;) {
      const page = okOf<{ texts: Array<{ textId: string }>; nextOffset?: number }>(await languages(set, { action: "texts", offset, limit: 500 }));
      expect(JSON.stringify(page).length).toBeLessThan(64 * 1024);
      for (const entry of page.texts) {
        seen.add(entry.textId);
      }
      pages += 1;
      if (page.nextOffset === undefined) {
        break;
      }
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(3000 + 11);
  });

  it("counts a page in UTF-8 bytes: 300 Japanese labels with a translation each stay under the 64 KB result cap", async () => {
    const root: ComponentNode = languagesRoot();
    const content = root.children?.content as ComponentNode[];
    const translations = languagesTranslations();
    for (let index = 0; index < 300; index += 1) {
      const label = `${String(index).padStart(3, "0")}`.repeat(1) + "これは長い質問のラベルです。".repeat(11);
      content.push({ id: `q${index}`, type: "text", configuration: { label } });
      translations.fr!.components![`q${index}`] = { label: { text: label, source: sourceHash(label) } };
    }
    const { BuilderController: Controller } = await import("../form-engine/builder/controller/builder-controller.js");
    const controller = new Controller({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS, localization: LANGUAGES, translations });
    const set = languagesBuilder({ controller });
    let offset = 0;
    let pages = 0;
    for (;;) {
      // The default arguments, and the largest limit: either must come back as a page, never as too-large.
      const page = okOf<{ texts: unknown[]; nextOffset?: number }>(await languages(set, { action: "texts", offset, limit: 500 }));
      expect(jsonByteLength(page)).toBeLessThanOrEqual(64 * 1024);
      pages += 1;
      if (page.nextOffset === undefined) {
        break;
      }
      offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(1);
    const first = okOf(await languages(set, { action: "texts" }));
    expect(jsonByteLength(first)).toBeLessThanOrEqual(64 * 1024);
  });

  it("answers list and texts during Stop, as reads, while a write action is stopped", async () => {
    const set = languagesBuilder();
    okOf(await set.builder.execute("begin_session", { purpose: "Languages" }));
    (set.stub.state.session as { onStop(): void }).onStop();
    await Promise.resolve();
    const before = set.builder.host.calls.length;
    okOf(await languages(set, { action: "list" }));
    okOf(await languages(set, { action: "texts" }));
    const events = set.builder.host.calls.slice(before).filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action");
    expect(events.map((call) => (call.args[1] as { readOnly: boolean }).readOnly)).toEqual([true, true]);
    expect(refusalOf(await languages(set, { action: "add", code: "de" })).code).toBe("stopped");
  });
});

describe("add: the source language is declared first, never guessed", () => {
  it("refuses a form that declares none without sourceLocale, with the documented words", async () => {
    const set = languagesBuilder({ localization: null });
    expect(refusalOf(await languages(set, { action: "add", code: "fr" }))).toEqual({
      ok: false,
      tool: "languages",
      builder: "builder-1",
      revision: 1,
      code: "source-locale-needed",
      retryable: false,
      message: "The form declares no languages, so adding fr would declare its texts as fr; nothing was added.",
      hint: "Say which language the form's texts are written in now with sourceLocale (ask the person, or read the labels with get_form), so they are not taken for fr.",
      details: { code: "fr" }
    });
    expect(set.controller.localization()).toBeUndefined();
  });

  it("declares sourceLocale first as the default in one step, leaving the texts exactly as they were", async () => {
    const set = languagesBuilder({ localization: null });
    const before = JSON_OF(set.controller.snapshot());
    const added = okOf(await languages(set, { action: "add", code: "fr", label: "Français", sourceLocale: "en" }));
    expect(added).toMatchObject({
      action: "add",
      changed: true,
      declared: true,
      defaultLanguage: "en",
      added: ["en", "fr"],
      languages: [
        { code: "en", label: "English", isDefault: true },
        { code: "fr", label: "Français", isDefault: false }
      ],
      changedSinceSave: { removed: [], renamed: [] },
      note: ["The form declared no languages: English (en), the language its texts are written in, was declared first."],
      undo: { steps: 1, ownSteps: 1, canUndo: true, canRedo: false },
      next: ["languages { action: 'texts', language: 'fr', missingOnly: true } lists what to translate.", "Write them with languages { action: 'translate' }."]
    });
    expect(set.controller.localization()).toEqual({ supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }], defaultLocale: "en" });
    expect(JSON_OF(set.controller.snapshot())).toEqual(before);
    expect(set.stub.callsOf("announce").at(-1)).toEqual(["Assistant changed the form's languages"]);
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(set.controller.localization()).toBeUndefined();
  });

  it("declares one language when sourceLocale is the code itself", async () => {
    const set = languagesBuilder({ localization: null });
    const added = okOf(await languages(set, { action: "add", code: "fr-CA", sourceLocale: "fr-CA" }));
    expect(added).toMatchObject({ changed: true, declared: true, defaultLanguage: "fr-CA", added: ["fr-CA"], undo: { steps: 1 } });
    expect(added).not.toHaveProperty("note");
    expect(set.controller.localization()?.supportedLocales).toHaveLength(1);
    expect(set.controller.localization()?.defaultLocale).toBe("fr-CA");
  });

  it("adds to a form that declares languages, dropping a sourceLocale with the warning", async () => {
    const set = languagesBuilder();
    const added = okOf(await languages(set, { action: "add", code: "de", sourceLocale: "fr" }));
    expect(added).toMatchObject({ changed: true, added: ["de"], defaultLanguage: "en", warnings: ["ignored argument for action 'add': sourceLocale (the form already declares its languages)"], undo: { steps: 1 } });
    expect(set.controller.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "fr", label: "Français" }, { code: "de", label: "Deutsch" }]);
    expect(set.controller.localization()?.defaultLocale).toBe("en");
  });

  it("a declared code with the same label is a no-op, judged before the grammar; another label or case is invalid-language-code", async () => {
    const set = languagesBuilder();
    const depth = undoDepth(set.controller);
    for (const input of [{ code: "fr" }, { code: "fr", label: "Français" }, { code: "en", label: "English" }]) {
      const same = okOf(await languages(set, { action: "add", ...input }));
      expect(same).toMatchObject({ action: "add", changed: false, declared: true });
      expect(same).not.toHaveProperty("added");
      expect(same).not.toHaveProperty("undo");
    }
    expect(undoDepth(set.controller)).toBe(depth);
    expect(refusalOf(await languages(set, { action: "add", code: "fr", label: "Francais" }))).toMatchObject({
      code: "invalid-language-code",
      details: { code: "fr" },
      hint: "Use a code such as 'fr' or 'fr-CA' that the form does not have yet; relabel changes a declared language's name."
    });
    expect(refusalOf(await languages(set, { action: "add", code: "FR" }))).toMatchObject({ code: "invalid-language-code", details: { code: "FR", problem: expect.stringContaining("\"fr\"") } });
    expect(set.controller.localization()).toEqual(LANGUAGES);
  });

  it("refuses a code that is not a language code, and a bad sourceLocale", async () => {
    const set = languagesBuilder();
    expect(refusalOf(await languages(set, { action: "add", code: "not a code" }))).toMatchObject({ code: "invalid-language-code", details: { code: "not a code" } });
    const none = languagesBuilder({ localization: null });
    expect(refusalOf(await languages(none, { action: "add", code: "fr", sourceLocale: "1" }))).toMatchObject({ code: "invalid-language-code", details: { code: "1" } });
    expect(none.controller.localization()).toBeUndefined();
  });

  it("answers feature-off with the languages feature off, before looking at the arguments' meaning", async () => {
    const set = languagesBuilder({ featureOn: { languages: false } });
    expect(refusalOf(await languages(set, { action: "add", code: "de" }))).toMatchObject({ code: "feature-off", details: { feature: "languages" } });
    expect(set.controller.localization()).toEqual(LANGUAGES);
  });
});

describe("rename, relabel and set_default: one step each", () => {
  it("renames a code, the texts following it, as one step that history takes back", async () => {
    const set = languagesBuilder();
    const renamed = okOf(await languages(set, { action: "rename", code: "fr", to: "fr-CA" }));
    expect(renamed).toMatchObject({
      action: "rename",
      changed: true,
      languages: [
        { code: "en", isDefault: true },
        { code: "fr-CA", label: "Français", isDefault: false, translated: 4, total: 11 }
      ],
      changedSinceSave: { removed: [], renamed: [{ from: "fr", to: "fr-CA" }] },
      undo: { steps: 1, canUndo: true }
    });
    expect(set.controller.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "fr-CA", label: "Français" }]);
    expect(frenchOf(set.controller, addressOf.component("name", "label"), "fr-CA")).toBe("Nom complet");
    expect(Object.keys(set.controller.translations() ?? {})).toEqual(["fr-CA"]);
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(set.controller.localization()).toEqual(LANGUAGES);
    expect(frenchOf(set.controller, addressOf.component("name", "label"))).toBe("Nom complet");
    expect(Object.keys(set.controller.translations() ?? {})).toEqual(["fr"]);
  });

  it("makes the renamed default follow, and refuses the unknown, the taken and the malformed", async () => {
    const set = languagesBuilder();
    okOf(await languages(set, { action: "rename", code: "en", to: "en-CA" }));
    expect(set.controller.localization()).toMatchObject({ defaultLocale: "en-CA" });
    expect(refusalOf(await languages(set, { action: "rename", code: "de", to: "de-AT" }))).toMatchObject({ code: "locale-unsupported", details: { locale: "de" } });
    expect(refusalOf(await languages(set, { action: "rename", code: "fr", to: "EN-ca" }))).toMatchObject({ code: "invalid-language-code", details: { code: "EN-ca" } });
    expect(refusalOf(await languages(set, { action: "rename", code: "fr", to: "x" }))).toMatchObject({ code: "invalid-language-code" });
    expect(okOf(await languages(set, { action: "rename", code: "fr", to: "fr" }))).toMatchObject({ changed: false });
  });

  it("relabels one language in one step; the same label is a no-op", async () => {
    const set = languagesBuilder();
    const relabeled = okOf(await languages(set, { action: "relabel", code: "fr", label: "Français (Canada)" }));
    expect(relabeled).toMatchObject({
      action: "relabel",
      changed: true,
      languages: [{ code: "en" }, { code: "fr", label: "Français (Canada)" }],
      undo: { steps: 1 },
      next: ["languages { action: 'texts', missingOnly: true } lists what is not translated yet."]
    });
    expect(set.controller.localization()?.supportedLocales).toEqual([{ code: "en" }, { code: "fr", label: "Français (Canada)" }]);
    expect(okOf(await languages(set, { action: "relabel", code: "fr", label: "Français (Canada)" }))).toMatchObject({
      changed: false,
      next: ["languages { action: 'texts', missingOnly: true } lists what is not translated yet."]
    });
    // A blank label puts the standard name back.
    expect(okOf(await languages(set, { action: "relabel", code: "fr", label: "" }))).toMatchObject({ changed: true, languages: [{}, { label: "Français" }] });
    expect(refusalOf(await languages(set, { action: "relabel", code: "de", label: "Deutsch" })).code).toBe("locale-unsupported");
  });

  it("makes another language the default: its wording becomes the source, counted in promotedTexts", async () => {
    const set = languagesBuilder();
    const made = okOf(await languages(set, { action: "set_default", code: "fr" }));
    expect(made).toMatchObject({
      action: "set_default",
      changed: true,
      defaultLanguage: "fr",
      promotedTexts: 4,
      languages: [{ code: "en", isDefault: false }, { code: "fr", isDefault: true }],
      undo: { steps: 1 },
      next: ["Tell the person 4 texts now read in fr as their source wording."]
    });
    expect(set.controller.getProperty("root", "title")).toBe("Permis");
    expect(frenchOf(set.controller, addressOf.form("title"), "en")).toBe("Permit");
    expect(frenchOf(set.controller, addressOf.form("title"))).toBeUndefined();
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(set.controller.localization()?.defaultLocale).toBe("en");
    expect(set.controller.getProperty("root", "title")).toBe("Permit");
    expect(frenchOf(set.controller, addressOf.form("title"))).toBe("Permis");
    // Already the default: nothing to write.
    expect(okOf(await languages(set, { action: "set_default", code: "en" }))).toMatchObject({ changed: false });
    expect(refusalOf(await languages(set, { action: "set_default", code: "de" })).code).toBe("locale-unsupported");
  });

  it("judges 'already the default' on the default the form reads, not on the stored field", async () => {
    const set = languagesBuilder({ localization: { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }] } });
    expect(okOf(await languages(set, { action: "list" })).languages).toMatchObject([{ code: "en", isDefault: true }, { code: "fr", isDefault: false }]);
    const depth = undoDepth(set.controller);
    const same = okOf(await languages(set, { action: "set_default", code: "en" }));
    expect(same).toMatchObject({ changed: false, next: ["languages { action: 'texts', missingOnly: true } lists what is not translated yet."] });
    expect(same).not.toHaveProperty("undo");
    expect(undoDepth(set.controller)).toBe(depth);
    expect(set.stub.callsOf("notice")).toEqual([]);
  });

  it("warns that a designer which is not on the page keeps the old code or the old source wording", async () => {
    const set = languagesBuilder();
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, notLoaded: ["journeys", "pdf"] };
    const renamed = okOf(await languages(set, { action: "rename", code: "fr", to: "fr-CA" }));
    // The translations of the journeys and the layouts are the map's, so they move with the rest;
    // only a layout's own document language is its block's.
    expect(renamed.warnings).toEqual(["outside-not-renamed: the PDF layouts are not loaded, so their document language keeps the code fr."]);
    const made = okOf(await languages(set, { action: "set_default", code: "fr-CA" }));
    expect(made.warnings).toEqual([
      "outside-not-swapped: the journeys are not loaded, so their texts keep the old source wording.",
      "outside-not-swapped: the PDF layouts are not loaded, so their texts keep the old source wording."
    ]);
  });

  it("goes through the controller's language actions, one call each", async () => {
    const set = languagesBuilder();
    const actions = set.controller.localizationActions;
    const calls = {
      add: vi.spyOn(actions, "addLocale"),
      relabel: vi.spyOn(actions, "relabelLocale"),
      makeDefault: vi.spyOn(actions, "makeDefaultLocale"),
      rename: vi.spyOn(actions, "renameLocale")
    };
    okOf(await languages(set, { action: "add", code: "de" }));
    okOf(await languages(set, { action: "relabel", code: "de", label: "Deutsch (Allemagne)" }));
    okOf(await languages(set, { action: "set_default", code: "fr" }));
    okOf(await languages(set, { action: "rename", code: "de", to: "de-AT" }));
    expect([calls.add, calls.relabel, calls.makeDefault, calls.rename].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(set.controller.hasPendingChanges(set.controller.rootId())).toBe(false);
  });

  it("leaves nothing behind when the controller refuses the action", async () => {
    const set = languagesBuilder();
    vi.spyOn(set.controller.localizationActions, "addLocale").mockReturnValue(false);
    const refused = refusalOf(await languages(set, { action: "add", code: "de" }));
    expect(refused).toMatchObject({
      code: "refused",
      message: "The builder did not add the language; nothing was changed.",
      hint: "Read message; it names the component and the reason. Call get_form if unsure."
    });
    expect(set.controller.hasPendingChanges(set.controller.rootId())).toBe(false);
    expect(set.controller.localization()).toEqual(LANGUAGES);
  });
});

describe("translate: one setTranslations step across every group", () => {
  it("writes fields, options, messages, the header and a journey's name in one undoable step", async () => {
    const set = languagesBuilder();
    const journey = withOutsideJourney(set);
    const depth = undoDepth(set.controller);
    const written = okOf(
      await languages(set, {
        action: "translate",
        translations: [
          { textId: "fields|components/name/description", language: "fr", text: "Comme sur votre pièce d'identité" },
          { textId: "options|components/kind/options/no/label", language: "fr", text: "Non" },
          { textId: "messages|components/name/messages/required", language: "fr", text: "Entrez votre nom" },
          { textId: "chrome|chrome/welcome/text", language: "fr", text: "Demande de permis" },
          { textId: "journeys|journeys/intake/name", language: "fr", text: "Accueil" }
        ]
      })
    );
    expect(written).toMatchObject({
      action: "translate",
      changed: true,
      written: [
        { textId: "fields|components/name/description", language: "fr" },
        { textId: "options|components/kind/options/no/label", language: "fr" },
        { textId: "messages|components/name/messages/required", language: "fr" },
        { textId: "chrome|chrome/welcome/text", language: "fr" },
        { textId: "journeys|journeys/intake/name", language: "fr" }
      ],
      undo: { steps: 1, ownSteps: 1, canUndo: true },
      next: ["languages { action: 'preview', code } shows the person the form in that language."]
    });
    expect(written).not.toHaveProperty("refused");
    expect(undoDepth(set.controller)).toBe(depth + 1);
    const controller = set.controller;
    expect(readTranslation(controller.translations(), "fr", addressOf.component("name", "description"))).toEqual({ text: "Comme sur votre pièce d'identité", source: sourceHash("As on your ID") });
    expect(frenchOf(controller, addressOf.option("kind", "no", "label"))).toBe("Non");
    expect(frenchOf(controller, addressOf.message("name", "required"))).toBe("Entrez votre nom");
    expect(frenchOf(controller, addressOf.chrome("welcome", "text"))).toBe("Demande de permis");
    expect(frenchOf(controller, addressOf.journey("intake", "name"))).toBe("Accueil");
    // The strings are untouched: translations live in the map.
    expect(controller.getProperty("name", "description")).toBe("As on your ID");
    expect(journey.value.name).toBe("Intake");
    expect(set.stub.callsOf("announce").at(-1)).toEqual(["Assistant wrote 5 translations"]);
    // One Undo takes the whole call back.
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(frenchOf(controller, addressOf.component("name", "description"))).toBeUndefined();
    expect(frenchOf(controller, addressOf.journey("intake", "name"))).toBeUndefined();
    expect(controller.translations()).toEqual(languagesTranslations());
  });

  it("refuses a cell of the default language: its wording is the text itself, never a translation", async () => {
    const set = languagesBuilder();
    const result = refusalOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/label", language: "en", text: "Your full name" }] }));
    expect(result).toMatchObject({
      code: "nothing-written",
      details: { refused: [{ textId: "fields|components/name/label", language: "en", code: "default-language", details: { language: "en", source: "Full name" } }] }
    });
    expect(set.controller.getProperty("name", "label")).toBe("Full name");
    expect(set.controller.translations()).toEqual(languagesTranslations());
  });

  it("removes a translation with '' and treats a text that already says that as no change", async () => {
    const set = languagesBuilder();
    const same = okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/label", language: "fr", text: "Nom complet" }] }));
    expect(same).toMatchObject({ changed: false, written: [], note: ["Every text already says that; nothing was changed."] });
    expect(same).not.toHaveProperty("undo");
    const emptied = okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/label", language: "fr", text: "" }] }));
    expect(emptied).toMatchObject({ changed: true, written: [{ textId: "fields|components/name/label", language: "fr" }] });
    expect(frenchOf(set.controller, addressOf.component("name", "label"))).toBeUndefined();
    expect(set.controller.getProperty("name", "label")).toBe("Full name");
  });

  it("lists a stale entry, and writing the same wording again confirms it", async () => {
    const set = languagesBuilder();
    set.controller.setProperty("name", "label", "Your full name");
    const listed = okOf<{ texts: Array<{ textId: string; stale?: string[] }> }>(await languages(set, { action: "texts", search: "nom complet" }));
    expect(listed.texts.map((entry) => [entry.textId, entry.stale])).toEqual([["fields|components/name/label", ["fr"]]]);
    const confirmed = okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/label", language: "fr", text: "Nom complet" }] }));
    expect(confirmed).toMatchObject({ changed: true, written: [{ textId: "fields|components/name/label", language: "fr" }] });
    expect(readTranslation(set.controller.translations(), "fr", addressOf.component("name", "label"))).toEqual({ text: "Nom complet", source: sourceHash("Your full name") });
    const again = okOf<{ texts: Array<{ stale?: string[] }> }>(await languages(set, { action: "texts", search: "nom complet" }));
    expect(again.texts[0]).not.toHaveProperty("stale");
  });

  it("names a text by its address, so a delete between texts and translate cannot aim the translation at another text", async () => {
    const set = languagesBuilder();
    const before = await textIds(set, { group: "options" });
    expect(before).toContain("options|components/kind/options/no/label");
    // The first option goes: the second moves up to index 0, but its id (by value) is the same.
    set.controller.setProperty("kind", "options", [{ value: "no", label: "No", description: "Not now" }]);
    expect(await textIds(set, { group: "options" })).toContain("options|components/kind/options/no/label");
    const gone = refusalOf(await languages(set, { action: "translate", translations: [{ textId: "options|components/kind/options/yes/label", language: "fr", text: "Oui!" }] }));
    expect(gone).toMatchObject({ code: "nothing-written", details: { refused: [{ code: "unknown-text" }] } });
    expect(frenchOf(set.controller, addressOf.option("kind", "no", "label"))).toBeUndefined();
    okOf(await languages(set, { action: "translate", translations: [{ textId: "options|components/kind/options/no/label", language: "fr", text: "Non" }] }));
    expect(frenchOf(set.controller, addressOf.option("kind", "no", "label"))).toBe("Non");
  });

  it("lists a header part's text under the part's own id, never its index", async () => {
    const set = languagesBuilder();
    expect(await textIds(set, { group: "chrome" })).toEqual(["chrome|chrome/welcome/text"]);
  });

  it("writes an entry stale when its source is not the current wording, and current when it is", async () => {
    const set = languagesBuilder();
    const id = "fields|components/name/description";
    const stale = okOf(await languages(set, { action: "translate", translations: [{ textId: id, language: "fr", text: "Comme sur votre ancienne pièce", source: "As on your old ID" }] }));
    expect(stale).toMatchObject({ changed: true, written: [{ textId: id, language: "fr" }], undo: { steps: 1 } });
    expect(readTranslation(set.controller.translations(), "fr", addressOf.component("name", "description"))).toEqual({ text: "Comme sur votre ancienne pièce", source: sourceHash("As on your old ID") });
    const listed = okOf<{ texts: Array<{ textId: string; stale?: string[] }> }>(await languages(set, { action: "texts", search: "ancienne" }));
    expect(listed.texts.map((entry) => [entry.textId, entry.stale])).toEqual([[id, ["fr"]]]);
    // A source that is the current wording is the ordinary current write.
    okOf(await languages(set, { action: "translate", translations: [{ textId: id, language: "fr", text: "Comme sur votre pièce", source: "As on your ID" }] }));
    expect(readTranslation(set.controller.translations(), "fr", addressOf.component("name", "description"))).toEqual({ text: "Comme sur votre pièce", source: sourceHash("As on your ID") });
  });

  it("writes a call that mixes stale and current entries as one undo step", async () => {
    const set = languagesBuilder();
    const depth = undoDepth(set.controller);
    okOf(
      await languages(set, {
        action: "translate",
        translations: [
          { textId: "fields|components/name/description", language: "fr", text: "Ancien", source: "Older wording" },
          { textId: "options|components/kind/options/no/label", language: "fr", text: "Non" }
        ]
      })
    );
    expect(undoDepth(set.controller)).toBe(depth + 1);
    expect(readTranslation(set.controller.translations(), "fr", addressOf.option("kind", "no", "label"))).toEqual({ text: "Non", source: sourceHash("No") });
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(frenchOf(set.controller, addressOf.component("name", "description"))).toBeUndefined();
    expect(frenchOf(set.controller, addressOf.option("kind", "no", "label"))).toBeUndefined();
  });

  it("refuses a write that adds a second repeated header and footer part id, even when one was already shared", async () => {
    // A form that arrived with a shared id (a file written elsewhere): the controller refuses to
    // make one, so the form is seeded with it.
    const root: ComponentNode = languagesRoot();
    const seeded = structuredClone(root.configuration) as { chrome: { header: Array<Record<string, unknown>>; footer?: Array<Record<string, unknown>> } };
    seeded.chrome.footer = [{ id: "welcome", type: "text", text: "Footer" }];
    root.configuration = seeded;
    const { BuilderController: Controller } = await import("../form-engine/builder/controller/builder-controller.js");
    const set = languagesBuilder({ controller: new Controller({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS, localization: LANGUAGES, translations: languagesTranslations() }) });
    const rootId = set.controller.rootId();
    const chromeOf = (): { header: Array<Record<string, unknown>>; footer?: Array<Record<string, unknown>> } => structuredClone(set.controller.getProperty(rootId, "chrome")) as never;
    // The controller itself refuses a write that adds a repeated id; the agent's guard says so before it gets there.
    const probe = chromeOf();
    probe.footer = [...(probe.footer ?? []), { id: "switcher", type: "text", text: "Again" }];
    expect(() => set.controller.setProperty(rootId, "chrome", probe)).toThrow(/"switcher" is used twice/);
    const more = chromeOf();
    more.footer = [...(more.footer ?? []), { id: "switcher", type: "text", text: "Again" }];
    const refused = refusalOf(await set.builder.execute("set_properties", { edits: [{ componentId: rootId, propertyPath: "chrome", value: more }] }));
    expect(refused).toMatchObject({ code: "blocked-property", details: { propertyPath: "chrome", message: expect.stringContaining('"switcher"') } });
    // A write that leaves the already shared id alone is not made to pay for it.
    const fine = chromeOf();
    fine.footer = [{ id: "welcome", type: "text", text: "Footer, reworded" }];
    okOf(await set.builder.execute("set_properties", { edits: [{ componentId: rootId, propertyPath: "chrome", value: fine }] }));
  });

  it("refuses entry by entry, writing the rest: unknown-text with its suggestions, locale-unsupported, and a designer not loaded", async () => {
    const set = languagesBuilder();
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, notLoaded: ["journeys", "pdf"] };
    const result = okOf<{ refused: Array<Record<string, unknown>>; written: unknown[] }>(
      await languages(set, {
        action: "translate",
        translations: [
          { textId: "fields|components/name/labell", language: "fr", text: "x" },
          { textId: "fields|components/name/description", language: "de", text: "x" },
          { textId: "journeys|journeys/intake/name", language: "fr", text: "Accueil" },
          { textId: "pdf|pdf/summary/name", language: "fr", text: "Résumé" },
          { textId: "fields|components/name/description", language: "fr", text: "Comme sur votre pièce" }
        ]
      })
    );
    expect(result.written).toEqual([{ textId: "fields|components/name/description", language: "fr" }]);
    expect(result.refused.map((entry) => [entry.textId, entry.code])).toEqual([
      ["fields|components/name/labell", "unknown-text"],
      ["fields|components/name/description", "locale-unsupported"],
      ["journeys|journeys/intake/name", "chunk-unavailable"],
      ["pdf|pdf/summary/name", "chunk-unavailable"]
    ]);
    expect(result.refused[0]).toMatchObject({
      language: "fr",
      details: { textId: "fields|components/name/labell", suggestions: ["fields|components/name/label"] },
      hint: "Use a textId from languages { action: 'texts' }; ids change after renames and edits."
    });
    expect(result.refused[1]).toMatchObject({ details: { locale: "de", supported: [{ code: "en" }, { code: "fr" }] } });
    expect(result.refused[2]).toMatchObject({ details: { what: "journeys", state: "loading" } });
  });

  it("answers nothing-written with every refusal when no entry could be written", async () => {
    const set = languagesBuilder();
    const depth = undoDepth(set.controller);
    const refused = refusalOf(await languages(set, { action: "translate", translations: [{ textId: "nope", language: "fr", text: "x" }] }));
    expect(refused).toMatchObject({ code: "nothing-written", details: { refused: [{ textId: "nope", code: "unknown-text" }] } });
    expect(undoDepth(set.controller)).toBe(depth);
  });

  it("offers up to five near textIds for an unknown one, nearest first, and an empty list when none is near", async () => {
    const set = await withFields(["ab", "a1", "x", "y", "abc", "abcd", "abcde"]);
    const result = okOf<{ refused: Array<{ textId: string; details: { suggestions: string[] } }> }>(
      await languages(set, {
        action: "translate",
        translations: [
          { textId: "fields|components/a/label", language: "fr", text: "x" },
          { textId: "completely-unrelated-text-id-of-some-length", language: "fr", text: "x" },
          { textId: "fields|components/name/description", language: "fr", text: "Comme" }
        ]
      })
    );
    // Six ids are within three edits (ab, a1, x, y at one; abc at two; abcd at three): five are
    // offered, the one-edit ids first, so a body that took one, or every near id, fails here.
    const suggestions = result.refused[0]?.details.suggestions ?? [];
    expect(suggestions).toHaveLength(5);
    expect([...suggestions.slice(0, 4)].sort()).toEqual(["fields|components/a1/label", "fields|components/ab/label", "fields|components/x/label", "fields|components/y/label"]);
    expect(suggestions[4]).toBe("fields|components/abc/label");
    expect(result.refused[1]?.details).toEqual({ textId: "completely-unrelated-text-id-of-some-length", suggestions: [] });
  });

  it("passes a designer's real state through: off and hidden are told to the person, not retried", async () => {
    const set = languagesBuilder();
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, notLoaded: ["journeys", "pdf"] };
    const ask = async (): Promise<Array<{ details: { what: string; state: string }; hint: string }>> => {
      const refused = refusalOf(
        await languages(set, {
          action: "translate",
          translations: [
            { textId: "journeys|journeys/intake/name", language: "fr", text: "Accueil" },
            { textId: "pdf|pdf/summary/name", language: "fr", text: "Résumé" }
          ]
        })
      );
      return (refused.details as { refused: Array<{ details: { what: string; state: string }; hint: string }> }).refused;
    };
    const ui = set.builder.host.ui as { journeys: () => unknown; pdfLayouts: () => unknown };
    ui.journeys = () => ({ state: "off" });
    ui.pdfLayouts = () => ({ state: "hidden" });
    const never = await ask();
    expect(never.map((entry) => entry.details)).toEqual([
      { what: "journeys", state: "off" },
      { what: "pdf", state: "hidden" }
    ]);
    expect(never[0]?.hint).toBe("This page does not show the journeys; tell the person.");
    expect(never[1]?.hint).toBe("This page does not show the PDF layouts; tell the person.");
    ui.journeys = () => ({ state: "failed" });
    ui.pdfLayouts = () => ({ state: "loading" });
    const others = await ask();
    expect(others.map((entry) => entry.details.state)).toEqual(["failed", "loading"]);
    expect(others[0]?.hint).toBe("Try once more; if it fails again the host removed that file: tell the person.");
    expect(others[1]?.hint).toBe("That part of the builder is still loading; call again in a moment.");
  });

  it("writes a layout's translations to the map without a step on the layout's own history", async () => {
    const set = languagesBuilder();
    const layout = documentController();
    const pdf = withOutsidePdfName(set, layout);
    const labelBefore = layout.getProperty("title", "label");
    okOf(await set.builder.execute("begin_session", { purpose: "Translate the layout" }));
    const written = okOf<{ elsewhere?: unknown; undo: Record<string, unknown> }>(
      await languages(set, { action: "translate", translations: [{ textId: "pdf|pdf/summary/name", language: "fr", text: "Résumé" }] })
    );
    expect(pdf.value.name).toBe("Summary");
    expect(pdf.writes).toBe(0);
    expect(frenchOf(set.controller, addressOf.pdf("summary", ["name"]))).toBe("Résumé");
    expect(written).not.toHaveProperty("elsewhere");
    expect(written.undo).not.toHaveProperty("journaled");
    expect(layout.getProperty("title", "label")).toBe(labelBefore);
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1 });
    expect(frenchOf(set.controller, addressOf.pdf("summary", ["name"]))).toBeUndefined();
  });

  it("reports no layout steps when no layout designer is open, or the write is only the form's", async () => {
    const set = languagesBuilder();
    const written = okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/description", language: "fr", text: "Comme" }] }));
    expect(written).not.toHaveProperty("elsewhere");
    expect(written.undo).not.toHaveProperty("journaled");
  });

  it("set_default puts the new name on the open layout without a step of the layout's history, and Undo all takes it back", async () => {
    const set = languagesBuilder();
    const layout = documentController();
    // The layout's name holds a French wording in the map, so the default swap rewrites its string.
    const pdf = withOutsidePdfName(set, layout);
    expect(set.controller.setTranslations([{ locale: "fr", address: addressOf.pdf("summary", ["name"]), text: "Résumé" }])).toBe(1);
    okOf(await set.builder.execute("begin_session", { purpose: "Change the languages" }));
    const written = okOf<{ elsewhere?: unknown; undo: Record<string, unknown> }>(await languages(set, { action: "set_default", code: "fr" }));
    expect(written).toMatchObject({ changed: true });
    expect(written).not.toHaveProperty("elsewhere");
    expect(written.undo).not.toHaveProperty("journaled");
    expect(pdf.value.name).toBe("Résumé");
    expect(layout.getProperty(layout.rootId(), "name")).toBe("Résumé");
    expect(layout.canUndo()).toBe(false);
    expect(frenchOf(set.controller, addressOf.pdf("summary", ["name"]), "en")).toBe("Summary");
    const undo = vi.spyOn(layout, "undo");
    okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(undo).not.toHaveBeenCalled();
    expect(pdf.value.name).toBe("Summary");
    expect(layout.getProperty(layout.rootId(), "name")).toBe("Summary");
    expect(frenchOf(set.controller, addressOf.pdf("summary", ["name"]))).toBe("Résumé");
  });

  it("lists every row writable: the map takes a translation of any text the form words", async () => {
    const set = languagesBuilder();
    const listed = okOf<{ texts: Array<{ writable: boolean }> }>(await languages(set, { action: "texts" }));
    expect(listed.texts.every((entry) => entry.writable)).toBe(true);
  });

  it("never writes the site's catalog: it warns that the catalog fills the language", async () => {
    const set = languagesBuilder();
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, catalog: { fr: { components: { name: { label: "Nom (catalogue)" } } } } };
    const listed = okOf<{ texts: Array<{ textId: string; catalog?: string[]; translations: Record<string, string> }> }>(await languages(set, { action: "texts", search: "full name" }));
    expect(listed.texts[0]).toMatchObject({ textId: "fields|components/name/label", catalog: ["fr"], translations: { fr: "Nom complet" } });
    expect(JSON.stringify(listed)).not.toContain("catalogue");
    const written = okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/label", language: "fr", text: "Nom" }] }));
    expect(written.warnings).toEqual(["fields|components/name/label: the site's catalog fills fr, so the form shows the catalog's wording instead of what was written"]);
    expect(frenchOf(set.controller, addressOf.component("name", "label"))).toBe("Nom");
  });

  it("checks every entry's keys at once, and the 500-entry bound", async () => {
    const set = languagesBuilder();
    const refused = refusalOf(await languages(set, { action: "translate", translations: [{ textId: "a" }, { language: "fr", text: "x" }] }));
    expect(refused).toMatchObject({
      code: "bad-input",
      details: {
        problems: [
          { key: "translations[0].language", expected: "required for action 'translate'" },
          { key: "translations[0].text", expected: "required for action 'translate'" },
          { key: "translations[1].textId", expected: "required for action 'translate'" }
        ]
      }
    });
    const many = Array.from({ length: 501 }, () => ({ textId: "fields|components/name/label", language: "fr", text: "x" }));
    expect(refusalOf(await languages(set, { action: "translate", translations: many }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "translations", expected: "at most 500 entries per call" }] } });
  });

  it("accepts translate with only the translations feature on, and refuses with both off", async () => {
    const set = languagesBuilder({ featureOn: { languages: false } });
    expect(okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/description", language: "fr", text: "Comme" }] }))).toMatchObject({ changed: true });
    const off = languagesBuilder({ featureOn: { languages: false, translations: false } });
    expect(refusalOf(await languages(off, { action: "translate", translations: [{ textId: "fields|components/name/description", language: "fr", text: "Comme" }] }))).toMatchObject({ code: "feature-off", details: { feature: "languages" } });
  });

  it("lists at most 50 refusals and counts the rest in a warning; only the first ten unknown ids get suggestions", async () => {
    const set = languagesBuilder();
    const entries = [{ textId: "fields|components/name/description", language: "fr", text: "Comme" }, ...Array.from({ length: 60 }, (_, index) => ({ textId: `fields|components/name/labe${index}`, language: "fr", text: "x" }))];
    const result = okOf<{ refused: Array<{ details: { suggestions: string[] } }>; warnings: string[] }>(await languages(set, { action: "translate", translations: entries }));
    expect(result.refused).toHaveLength(50);
    expect(result.warnings).toEqual(["10 more entries were refused and are not listed"]);
    // The near-id search is quadratic, so it runs for ten entries and the rest carry none.
    expect(result.refused.slice(0, 10).every((entry) => entry.details.suggestions.includes("fields|components/name/label"))).toBe(true);
    expect(result.refused.slice(10).every((entry) => entry.details.suggestions.length === 0)).toBe(true);
  });

  it("keeps at most ten warnings from the entries themselves", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `w${index}`);
    const set = await withFields(ids);
    const catalog: Record<string, { label: string }> = Object.fromEntries(ids.map((id) => [id, { label: `catalogue ${id}` }]));
    set.stub.state.languageInputs = { ...set.stub.state.languageInputs, catalog: { fr: { components: catalog } } };
    const result = okOf<{ written: unknown[]; warnings: string[] }>(
      await languages(set, { action: "translate", translations: ids.map((id) => ({ textId: `fields|components/${id}/label`, language: "fr", text: `New ${id}` })) })
    );
    expect(result.written).toHaveLength(12);
    expect(result.warnings).toHaveLength(10);
    expect(result.warnings[0]).toBe("fields|components/w0/label: the site's catalog fills fr, so the form shows the catalog's wording instead of what was written");
  });
});

describe("the person's state comes first", () => {
  it("yields to the Form panel's unapplied edit for every write, raising no prompt", async () => {
    const set = languagesBuilder();
    const form = set.controller;
    form.select(form.rootId());
    form.setDraftProperty(form.rootId(), "title", "Draft title");
    for (const input of [
      { action: "add", code: "de" },
      { action: "rename", code: "fr", to: "fr-CA" },
      { action: "relabel", code: "fr", label: "X" },
      { action: "set_default", code: "fr" },
      { action: "translate", translations: [{ textId: "fields|components/name/description", language: "fr", text: "x" }] }
    ]) {
      expect(refusalOf(await languages(set, input))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "root" } });
    }
    expect(form.unsavedChangesPrompt()).toBeUndefined();
    expect(form.localization()).toEqual(LANGUAGES);
    // A read is not a write: the draft does not hold it back.
    okOf(await languages(set, { action: "list" }));
  });

  it("yields to the Languages workspace's typed cells with their count, the guard's subject naming them", async () => {
    const set = languagesBuilder({ stub: { languagesPending: 3 } });
    set.controller.setLeaveGuard(guard("languages-texts"));
    expect(refusalOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/description", language: "fr", text: "x" }] }))).toEqual(
      expect.objectContaining({
        code: "unsaved-draft",
        message: "The person has translations typed in the Languages workspace that are not applied yet; nothing was changed.",
        hint: "The person is editing languages-texts; ask them to apply or discard that edit, then call again. Do not retry on your own.",
        details: { reason: "draft", componentId: "languages-texts", cells: 3 }
      })
    );
    // Another panel's guard (the Tests panel's) is not the languages edit.
    set.controller.setLeaveGuard(guard("tests-panel"));
    okOf(await languages(set, { action: "add", code: "de" }));
  });

  it("refuses with the prompt's own shape when the builder asks the person about an edit, never answering it", async () => {
    const set = languagesBuilder();
    const form = set.controller;
    form.select("name");
    form.setDraftProperty("name", "label", "Draft");
    form.requestSelect("kind");
    expect(form.unsavedChangesPrompt()).toBeDefined();
    expect(refusalOf(await languages(set, { action: "add", code: "de" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt" } });
    expect(form.unsavedChangesPrompt()).toBeDefined();
  });

  it("is not refused by Try it or a designer: texts change live where the person looks", async () => {
    const set = languagesBuilder({ stub: { trying: true, mode: "pdf", workspace: "pdf" } });
    expect(okOf(await languages(set, { action: "add", code: "de" }))).toMatchObject({ changed: true });
  });
});

describe("preview: the canvas in a language, with no step", () => {
  it("calls the bar's locale path and changes no history and no revision", async () => {
    const set = languagesBuilder();
    const depth = undoDepth(set.controller);
    const before = okOf(await languages(set, { action: "list" })).revision;
    const previewed = okOf(await languages(set, { action: "preview", code: "fr" }));
    expect(previewed).toMatchObject({ action: "preview", changed: false, next: ["The person sees the form in fr; preview the default language again when you are done."] });
    expect(previewed).not.toHaveProperty("undo");
    expect(set.stub.callsOf("setPreviewLocale")).toEqual([["fr"]]);
    expect(undoDepth(set.controller)).toBe(depth);
    expect(previewed.revision).toBe(before);
    expect(set.controller.localization()).toEqual(LANGUAGES);
  });

  it("refuses an undeclared code, and a bare controller with no-ui", async () => {
    const set = languagesBuilder();
    expect(refusalOf(await languages(set, { action: "preview", code: "de" }))).toMatchObject({ code: "locale-unsupported", details: { locale: "de" } });
    expect(set.stub.callsOf("setPreviewLocale")).toEqual([]);
    const { agentBuilder } = await import("./fixtures/agent-builder.js");
    const { languagesController } = await import("./fixtures/builder-languages.js");
    const bare = agentBuilder({ controller: languagesController() });
    expect(refusalOf(await bare.execute("languages", { action: "preview", code: "fr" }))).toMatchObject({ code: "no-ui", hint: "This builder runs without its page; nothing can be shown." });
  });
});

describe("the folded convention's grammar", () => {
  it("names every missing argument at once and drops an argument the action does not read, with a warning", async () => {
    const set = languagesBuilder();
    expect(refusalOf(await languages(set, { action: "rename" }))).toMatchObject({
      code: "bad-input",
      details: { problems: [{ key: "code", expected: "required for action 'rename'" }, { key: "to", expected: "required for action 'rename'" }] }
    });
    expect(refusalOf(await languages(set, { action: "relabel", code: "fr" }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "label", expected: "required for action 'relabel'" }] } });
    expect(refusalOf(await languages(set, { action: "translate" }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "translations", expected: "required for action 'translate'" }] } });
    const listed = okOf(await languages(set, { action: "list", code: "fr", limit: 3 }));
    expect(listed.warnings).toEqual(["ignored argument for action 'list': code", "ignored argument for action 'list': limit"]);
  });
});

describe("the 512 KB input", () => {
  const entries = (count: number): Array<{ textId: string; language: string; text: string }> =>
    Array.from({ length: count }, (_, index) => ({ textId: `nope-${index}`, language: "fr", text: "x".repeat(16_000) }));

  it("accepts a 400 KB call and refuses a 600 KB one as too-large", async () => {
    const set = languagesBuilder();
    const accepted = refusalOf(await languages(set, { action: "translate", translations: entries(25) }));
    expect(accepted.code).toBe("nothing-written");
    const tooLarge = refusalOf(await languages(set, { action: "translate", translations: entries(38) }));
    expect(tooLarge.code).toBe("too-large");
  });
});

describe("sessions: Undo all reaches the form steps and the journaled list changes in one order", () => {
  it("undoes languages { add }, documents { new } and another languages write newest first", async () => {
    const set = languagesBuilder();
    const journeysBefore = JSON_OF(set.page.journeys.configuration);
    const languagesBefore = JSON_OF(set.controller.localization());
    const snapshotBefore = JSON_OF(set.controller.snapshot());
    okOf(await set.builder.execute("begin_session", { purpose: "Translate the form" }));
    okOf(await languages(set, { action: "add", code: "de", label: "Deutsch" }));
    okOf(await set.builder.execute("documents", { action: "new", kind: "journey", name: "Short" }));
    okOf(await languages(set, { action: "translate", translations: [{ textId: "fields|components/name/description", language: "de", text: "Wie im Ausweis" }] }));
    expect(set.page.journeys.configuration.journeys?.map((journey) => journey.id)).toContain("journey-1");
    // The order the reversals run in: each one writes a label, so a wrong interleave (every journal
    // entry before every form step, say) shows here and not only in an end state that is the same.
    const order: string[] = [];
    const realUndo = set.controller.undo.bind(set.controller);
    vi.spyOn(set.controller, "undo").mockImplementation(() => {
      order.push("form");
      return realUndo();
    });
    for (const method of ["applyCatalog", "remove"] as const) {
      const real = set.page.journeys.actions[method].bind(set.page.journeys.actions) as (...args: unknown[]) => unknown;
      vi.spyOn(set.page.journeys.actions, method).mockImplementation(((...args: unknown[]) => {
        order.push("journal");
        return real(...args);
      }) as never);
    }
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(order).toEqual(["form", "journal", "form"]);
    expect(ended.session).toMatchObject({ undone: 3 });
    expect(JSON_OF(set.page.journeys.configuration)).toEqual(journeysBefore);
    expect(JSON_OF(set.controller.localization())).toEqual(languagesBefore);
    expect(JSON_OF(set.controller.snapshot())).toEqual(snapshotBefore);
  });

  it("takes the notice's Undo back as one step, the languages' own history step", async () => {
    const set = languagesBuilder();
    okOf(await languages(set, { action: "add", code: "de" }));
    const notice = set.stub.callsOf("notice").at(-1) as [string, { label: string; run(): void }];
    expect(notice[0]).toBe("Assistant changed the form's languages");
    expect(notice[1].label).toBe("Undo");
    notice[1].run();
    expect(set.controller.localization()).toEqual(LANGUAGES);
  });
});
