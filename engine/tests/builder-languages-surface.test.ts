// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderController, TranslatableText } from "../form-engine/builder/controller/builder-controller.js";
import {
  chromeWithSwitcher,
  chromeWithSwitcherLabel,
  defineLanguagesSurface,
  switcherState,
  DATUM_BUILDER_LANGUAGES_TAG,
  type DatumBuilderLanguagesElement
} from "../form-engine/builder/languages/languages-surface.js";
import { addressOf, readTranslation } from "../form-engine/core/localization/translations.js";
import { languageCodeIssue, languageCodeProblem, languageRenameIssue } from "../form-engine/builder/controller/language-edits.js";
import { defineBuilderLogic, DATUM_BUILDER_LOGIC_TAG } from "../form-engine/builder/logic/logic-surface.js";
import { languagesController, languagesRoot } from "./fixtures/builder-languages.js";

/*
 * The Languages surface, driven the way a person does: the language cards,
 * the switcher row that writes the chrome part, the Texts with their rail and filters, the
 * pending bar whose Apply is one undo step, the leave guard, Confirm on a stale cell and the goto
 * filter. jsdom applies no shadow CSS, so these assert attributes and classes the script sets.
 */

defineLanguagesSurface();
defineBuilderLogic();

afterEach(() => {
  document.body.innerHTML = "";
});

interface Mounted {
  surface: DatumBuilderLanguagesElement;
  controller: BuilderController;
  root: ShadowRoot;
}

function mount(controller: BuilderController = languagesController()): Mounted {
  const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
  surface.controller = controller;
  document.body.append(surface);
  return { surface, controller, root: surface.shadowRoot! };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) {
    throw new Error(`nothing matches ${selector}`);
  }
  return found;
};

const cell = (root: ParentNode, key: string, locale = "fr"): HTMLInputElement => q<HTMLInputElement>(root, `[data-languages-cell="${key}"][data-languages-locale="${locale}"]`);

function type(box: HTMLInputElement, value: string): void {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

const rowKeys = (root: ParentNode): string[] => [...root.querySelectorAll("[data-languages-row]")].map((row) => row.getAttribute("data-languages-row")!);

/** The form root's stored chrome. */
const chromeOf = (controller: BuilderController): unknown => (controller.snapshot().configuration as Record<string, unknown>).chrome;

const NAME = "components/name/label";
const KIND = "components/kind/label";
const TITLE = "form/title";

describe("the language cards", () => {
  it("lets a card's one column shrink so the name input cannot push the menu button past the card", () => {
    const { root } = mount();
    // jsdom does no layout, so the guard is the rule itself: an auto track takes the input's intrinsic width as its minimum.
    expect(q(root, "style").textContent).toMatch(/\.lang \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  });

  it("draws a card per language with the Default badge, its share translated and what is missing", () => {
    const { root } = mount();
    const cards = [...root.querySelectorAll("[data-languages-lang]")].map((card) => card.getAttribute("data-languages-lang"));
    expect(cards).toEqual(["en", "fr"]);
    expect(q(root, '[data-languages-lang="en"] [data-languages-default-badge]').textContent).toBe("Default");
    expect(root.querySelector('[data-languages-lang="fr"] [data-languages-default-badge]')).toBeNull();
    // The default language has no translations of its own, so no share is drawn for it.
    expect(root.querySelector('[data-languages-lang="en"] progress')).toBeNull();
    const fr = q(root, '[data-languages-lang="fr"]');
    expect(q(fr, "progress").getAttribute("aria-label")).toBe("Translated into Français");
    expect(q(fr, "[data-languages-percent]").textContent).toMatch(/^\d+% translated$/);
    expect(q(fr, "[data-languages-missing-count]").textContent).toMatch(/^\d+ missing$/);
    // Menu items are the card's, shut until opened.
    expect(q(fr, ".lang-menu").hasAttribute("hidden")).toBe(true);
    q(fr, "[data-languages-menu]").click();
    expect(q(root, '[data-languages-lang="fr"] .lang-menu').hasAttribute("hidden")).toBe(false);
    expect(q(root, '[data-languages-lang="fr"] [data-languages-menu]').getAttribute("aria-expanded")).toBe("true");
  });

  it("counts the source-changed texts on the card", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    expect(q(root, '[data-languages-lang="fr"] [data-languages-stale-count]').textContent).toBe("1 source changed");
  });

  it("adds a language through the controller, one undo step", () => {
    const { root, controller } = mount();
    type(q<HTMLInputElement>(root, "[data-languages-add-code]"), "es");
    q(root, "[data-languages-add]").click();
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr", "es"]);
    expect(root.querySelector('[data-languages-lang="es"]')).not.toBeNull();
    controller.undo();
    expect(controller.localization()?.supportedLocales).toHaveLength(2);
  });

  it("refuses a bad code under the box, writing nothing", () => {
    const { root, controller } = mount();
    type(q<HTMLInputElement>(root, "[data-languages-add-code]"), "not a code");
    q(root, "[data-languages-add]").click();
    expect(q(root, "#languages-add-problem").textContent).toContain("not a language code");
    expect(controller.localization()?.supportedLocales).toHaveLength(2);
  });

  it("asks before removing, then removes the language and its translations in one step", () => {
    const { root, controller } = mount();
    q(root, '[data-languages-remove="fr"]').click();
    expect(q(root, "[data-languages-confirm]").textContent).toContain("4 translations");
    q(root, "[data-languages-remove-keep]").click();
    expect(controller.localization()?.supportedLocales).toHaveLength(2);
    q(root, '[data-languages-remove="fr"]').click();
    q(root, "[data-languages-remove-confirm]").click();
    expect(controller.localization()?.supportedLocales).toHaveLength(1);
    expect(controller.translations()).toBeUndefined();
    controller.undo();
    expect(readTranslation(controller.translations(), "fr", addressOf.component("name", "label"))?.text).toBe("Nom complet");
  });

  it("asks before making a language the default, then swaps the strings", () => {
    const { root, controller } = mount();
    q(root, '[data-languages-default="fr"]').click();
    expect(q(root, "[data-languages-default-confirm-box]").textContent).toContain("Français");
    q(root, "[data-languages-default-confirm]").click();
    expect(controller.localization()?.defaultLocale).toBe("fr");
    expect(controller.getProperty("name", "label")).toBe("Nom complet");
    expect(q(root, '[data-languages-lang="fr"] [data-languages-default-badge]')).toBeTruthy();
  });

  it("renames a code and keeps the translations under the new one", () => {
    const { root, controller } = mount();
    q(root, '[data-languages-rename="fr"]').click();
    const box = q<HTMLInputElement>(root, "[data-languages-rename-code]");
    type(box, "fr-CA");
    q(root, "[data-languages-rename-confirm]").click();
    expect(readTranslation(controller.translations(), "fr-CA", addressOf.component("name", "label"))?.text).toBe("Nom complet");
    expect(root.querySelector('[data-languages-lang="fr-CA"]')).not.toBeNull();
  });

  it("names a language on leaving the box", () => {
    const { root, controller } = mount();
    const box = q<HTMLInputElement>(root, '[data-languages-label="fr"]');
    box.value = "Français canadien";
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(controller.localization()?.supportedLocales?.find((entry) => typeof entry !== "string" && entry.code === "fr")).toMatchObject({ label: "Français canadien" });
  });
});

describe("the empty state (no second language yet)", () => {
  it("invites Add a language, keeps the switcher row and lists the texts in the default only", () => {
    const { root } = mount(languagesController(null));
    expect(q(root, "[data-languages-invite]").textContent).toContain("Add a second");
    expect(root.querySelector("[data-languages-lang]")).toBeNull();
    expect(root.querySelector("[data-languages-switcher]")).not.toBeNull();
    // No translation cell, no status filter, no view toggle: the texts as they are written.
    expect(root.querySelector("[data-languages-cell]")).toBeNull();
    expect(root.querySelector("[data-languages-status]")).toBeNull();
    expect(root.querySelector("[data-languages-view]")).toBeNull();
    expect(rowKeys(root)).toContain(NAME);
    expect(q(root, `[data-languages-row="${NAME}"] td.default`).textContent).toBe("Full name");
  });

  it("declares the language the strings are written in when the first language is added", () => {
    const { root, controller } = mount(languagesController(null));
    type(q<HTMLInputElement>(root, "[data-languages-add-code]"), "fr");
    q(root, "[data-languages-add]").click();
    expect(controller.localization()?.supportedLocales?.map((entry) => (typeof entry === "string" ? entry : entry.code))).toEqual(["en", "fr"]);
    expect(controller.localization()?.defaultLocale).toBe("en");
  });
});

describe("the switcher row", () => {
  it("reads where the form shows the switcher and its label", () => {
    const { root } = mount();
    expect(q<HTMLSelectElement>(root, "[data-languages-switcher-place]").value).toBe("header");
    expect(q<HTMLInputElement>(root, "[data-languages-switcher-label]").value).toBe("");
  });

  it("moves the part to the footer, keeping its id, in one undo step", () => {
    const { root, controller } = mount();
    choose(q<HTMLSelectElement>(root, "[data-languages-switcher-place]"), "footer");
    const chrome = chromeOf(controller) as { header?: Array<{ id: string }>; footer?: Array<{ id: string; type: string }> };
    expect(chrome.header?.map((part) => part.id)).toEqual(["welcome"]);
    expect(chrome.footer).toEqual([{ id: "switcher", type: "language-switcher" }]);
    expect(q<HTMLSelectElement>(root, "[data-languages-switcher-place]").value).toBe("footer");
    controller.undo();
    expect((chromeOf(controller) as { header: unknown[] }).header).toHaveLength(2);
  });

  it("writes the label to the part", () => {
    const { root, controller } = mount();
    const box = q<HTMLInputElement>(root, "[data-languages-switcher-label]");
    box.value = "Choose a language";
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const chrome = chromeOf(controller) as { header: Array<{ id: string; label?: string }> };
    expect(chrome.header.find((part) => part.id === "switcher")?.label).toBe("Choose a language");
  });

  it("takes the part away for Not shown, and its translations with it", () => {
    const controller = languagesController();
    const { root } = mount(controller);
    const box = q<HTMLInputElement>(root, "[data-languages-switcher-label]");
    box.value = "Langue";
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(controller.setTranslations([{ locale: "fr", address: addressOf.chrome("switcher", "label"), text: "Langue" }])).toBe(1);
    choose(q<HTMLSelectElement>(root, "[data-languages-switcher-place]"), "none");
    const chrome = chromeOf(controller) as { header: Array<{ id: string }> };
    expect(chrome.header.map((part) => part.id)).toEqual(["welcome"]);
    expect(readTranslation(controller.translations(), "fr", addressOf.chrome("switcher", "label"))).toBeUndefined();
    expect(q<HTMLInputElement>(root, "[data-languages-switcher-label]").disabled).toBe(true);
  });

  it("adds a switcher with a fresh part id when the form has none", () => {
    const controller = languagesController();
    const { root } = mount(controller);
    choose(q<HTMLSelectElement>(root, "[data-languages-switcher-place]"), "none");
    choose(q<HTMLSelectElement>(root, "[data-languages-switcher-place]"), "footer");
    const chrome = chromeOf(controller) as { footer: Array<{ id: string; type: string }> };
    expect(chrome.footer).toHaveLength(1);
    expect(chrome.footer[0]!.type).toBe("language-switcher");
    // The first part_N free across both regions.
    expect(chrome.footer[0]!.id).toBe("part_1");
  });

  it("reads and writes the preview language through the controller", () => {
    const { root, controller } = mount();
    expect(q<HTMLSelectElement>(root, "[data-languages-preview]").value).toBe(controller.currentLocale());
    choose(q<HTMLSelectElement>(root, "[data-languages-preview]"), "fr");
    expect(controller.currentLocale()).toBe("fr");
    expect(q<HTMLSelectElement>(root, "[data-languages-preview]").value).toBe("fr");
  });
});

describe("the switcher chrome arithmetic", () => {
  it("finds a switcher inside a group, and moves it out as a part of its own", () => {
    const chrome = { header: [{ id: "row", type: "group", parts: [{ id: "logo", type: "image", src: "/a.png" }, { id: "sw", type: "language-switcher" }] }] };
    expect(switcherState(chrome)).toEqual({ place: "header", label: "" });
    const moved = chromeWithSwitcher(chrome, "footer", "Language");
    expect(moved).toEqual({ header: [{ id: "row", type: "group", parts: [{ id: "logo", type: "image", src: "/a.png" }] }], footer: [{ id: "sw", type: "language-switcher", label: "Language" }] });
  });

  it("leaves a switcher where it is when it is asked to be there", () => {
    const chrome = { header: [{ id: "row", type: "group", parts: [{ id: "sw", type: "language-switcher" }, { id: "logo", type: "image", src: "/a.png" }] }] };
    expect(chromeWithSwitcher(chrome, "header", "")).toEqual(chrome);
  });

  it("drops the chrome block when nothing is left, and labels every switcher", () => {
    expect(chromeWithSwitcher({ header: [{ id: "sw", type: "language-switcher" }] }, "none", "")).toBeUndefined();
    const both = { header: [{ id: "a", type: "language-switcher" }], footer: [{ id: "b", type: "language-switcher" }] };
    expect(switcherState(both).place).toBe("both");
    expect(chromeWithSwitcherLabel(both, "Pick")).toEqual({ header: [{ id: "a", type: "language-switcher", label: "Pick" }], footer: [{ id: "b", type: "language-switcher", label: "Pick" }] });
  });
});

describe("the Texts list", () => {
  it("lists every text under its group with a cell per language and the rail counts", () => {
    const { root } = mount();
    expect(rowKeys(root)).toEqual(expect.arrayContaining([TITLE, NAME, KIND, "form/messages/required", "components/kind/options/yes/label", "chrome/welcome/text"]));
    const rail = [...root.querySelectorAll("[data-languages-group]")].map((button) => button.getAttribute("data-languages-group"));
    // The engine's own words follow the form's texts, English as their source.
    expect(rail).toEqual(["all", "fields", "options", "messages", "chrome", "texts"]);
    expect(cell(root, NAME).value).toBe("Nom complet");
    expect(cell(root, KIND).value).toBe("");
  });

  it("words an option and a header part from its address, in the builder's words", () => {
    const { root } = mount();
    const label = (key: string): string => q(root, `[data-languages-row="${key}"] th.what`).textContent!.trim();
    expect(label("components/kind/options/yes/label")).toBe("Option “yes”");
    expect(label("components/kind/options/no/description")).toBe("Option “no” · Description");
    expect(label("chrome/welcome/text")).toBe("Header › welcome");
  });

  it("narrows to a group on the rail", () => {
    const { root } = mount();
    q(root, '[data-languages-group="options"]').click();
    expect(q(root, '[data-languages-group="options"]').getAttribute("aria-pressed")).toBe("true");
    expect(rowKeys(root).every((key) => key.startsWith("components/kind/options/"))).toBe(true);
    q(root, '[data-languages-group="all"]').click();
    expect(rowKeys(root).length).toBeGreaterThan(4);
  });

  it("searches without repainting the box being typed in, once the box has been still", () => {
    vi.useFakeTimers();
    try {
      const { root } = mount();
      const search = q<HTMLInputElement>(root, "[data-languages-search]");
      type(search, "nom complet");
      // The table waits out the pause; the box is untouched either way.
      expect(rowKeys(root).length).toBeGreaterThan(1);
      vi.advanceTimersByTime(150);
      expect(rowKeys(root)).toEqual([NAME]);
      expect(q(root, "[data-languages-search]")).toBe(search);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by status and marks each cell with it", () => {
    const { root, controller } = mount();
    expect(q(root, `[data-languages-cell="${NAME}"]`).closest("td")!.classList.contains("present")).toBe(true);
    expect(cell(root, KIND).closest("td")!.classList.contains("missing")).toBe(true);
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "missing");
    expect(rowKeys(root)).not.toContain(NAME);
    expect(rowKeys(root)).toContain(KIND);
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "stale");
    expect(root.querySelector("[data-languages-row]")).toBeNull();
    controller.setProperty("name", "label", "Your name");
    expect(rowKeys(root)).toEqual([NAME]);
    expect(cell(root, NAME).closest("td")!.classList.contains("stale")).toBe(true);
  });

  it("shows a cell the page overrides read-only, with a marker and the catalog's text", () => {
    const controller = languagesController();
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.translationCatalog = { fr: { components: { kind: { label: "Genre (page)" } } } };
    surface.controller = controller;
    document.body.append(surface);
    const root = surface.shadowRoot!;
    const box = cell(root, KIND);
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe("Genre (page)");
    expect(box.closest("td")!.classList.contains("overridden")).toBe(true);
    expect(q(box.closest("td")!, ".marker--page").textContent).toBe("Set by the page");
    expect(box.closest("td")!.querySelector("[data-languages-reconcile]")).toBeNull();
    // Typing into it changes nothing.
    type(box, "ignored");
    expect(surface.pendingCount).toBe(0);
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "overridden");
    expect(rowKeys(root)).toEqual([KIND]);
  });

  it("leaves a regional cell editable when the page words only its primary language, and says what the page shows", () => {
    const regional = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français (Canada)" }], defaultLocale: "en" });
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.translationCatalog = { fr: { components: { kind: { label: "Genre (page fr)" } } } };
    surface.controller = regional;
    document.body.append(surface);
    const root = surface.shadowRoot!;
    const box = cell(root, KIND, "fr-CA");
    const td = box.closest("td")!;
    expect(box.readOnly).toBe(false);
    expect(box.value).toBe("");
    expect(td.classList.contains("overridden")).toBe(false);
    expect(q(td, "[data-languages-page-wording]").textContent).toBe("The page says “Genre (page fr)” until you translate it.");
    // The author's own text is theirs to write: it is pending, and the note goes.
    type(box, "Genre");
    expect(surface.pendingCount).toBe(1);
    expect(cell(root, KIND, "fr-CA").closest("td")!.querySelector("[data-languages-page-wording]")).toBeNull();
  });

  it("offers Confirm on a stale cell, which keeps the translation and clears the flag in one step", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    const td = cell(root, NAME).closest("td")!;
    expect(q(td, ".marker--stale").textContent).toBe("Source changed");
    q(td, "[data-languages-reconcile]").click();
    expect(cell(root, NAME).closest("td")!.classList.contains("present")).toBe(true);
    expect(cell(root, NAME).value).toBe("Nom complet");
    expect(readTranslation(controller.translations(), "fr", addressOf.component("name", "label"))?.text).toBe("Nom complet");
    expect(root.querySelector("[data-languages-reconcile]")).toBeNull();
    controller.undo();
    expect(cell(root, NAME).closest("td")!.classList.contains("stale")).toBe(true);
  });
});

describe("the one-language view", () => {
  it("shows one language beside the default text and moves Enter to the next text that needs the author", () => {
    const controller = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "de" }], defaultLocale: "en" });
    const { root } = mount(controller);
    expect(root.querySelectorAll('input[data-languages-locale="de"]').length).toBeGreaterThan(0);
    q(root, '[data-languages-view="one"]').click();
    expect(q(root, '[data-languages-view="one"]').getAttribute("aria-pressed")).toBe("true");
    expect(q<HTMLSelectElement>(root, "[data-languages-language]").value).toBe("fr");
    expect(root.querySelectorAll('input[data-languages-locale="de"]')).toHaveLength(0);
    // French has a name label already; Enter from the title skips it and lands on the next one missing.
    const title = cell(root, TITLE);
    expect(title.value).toBe("Permis");
    const order = [...root.querySelectorAll<HTMLInputElement>("input[data-languages-cell]")];
    const nextMissing = order.slice(order.indexOf(title) + 1).find((box) => box.closest("td")!.dataset.status === "missing")!;
    title.focus();
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(root.activeElement).toBe(nextMissing);
    // Answering a cell makes it done: Enter from it goes on, not back.
    type(nextMissing, "Réponse");
    nextMissing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(root.activeElement).not.toBe(nextMissing);
    expect((root.activeElement as HTMLElement).closest("td")!.dataset.status).toBe("missing");
  });

  it("does not move on Enter in the all-languages grid", () => {
    const { root } = mount();
    const title = cell(root, TITLE);
    title.focus();
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(root.activeElement).toBe(title);
  });
});

describe("pending cells, Apply and the leave guard", () => {
  it("counts typed changes in the bar, and typing writes nothing", () => {
    const { surface, root, controller } = mount();
    const bar = q(root, "[data-languages-pending]");
    expect(bar.hasAttribute("hidden")).toBe(true);
    type(cell(root, KIND), "Genre");
    type(cell(root, "components/kind/options/no/label"), "Non");
    expect(bar.hasAttribute("hidden")).toBe(false);
    expect(q(root, "[data-languages-pending-count]").textContent).toBe("2 changes");
    expect(surface.pendingCount).toBe(2);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
    // Typing the stored text back is no change.
    type(cell(root, KIND), "");
    expect(q(root, "[data-languages-pending-count]").textContent).toBe("1 change");
    expect(cell(root, KIND).closest("td")!.classList.contains("changed")).toBe(false);
  });

  it("updates the card's share as cells are typed", () => {
    const { root } = mount();
    const before = q(root, '[data-languages-lang="fr"] [data-languages-percent]').textContent;
    type(cell(root, KIND), "Genre");
    expect(q(root, '[data-languages-lang="fr"] [data-languages-percent]').textContent).not.toBe(before);
  });

  it("Apply is one setTranslations call, so one undo step", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    type(cell(root, "components/kind/options/no/label"), "Non");
    type(cell(root, NAME), "Nom");
    q(root, "[data-languages-apply]").click();
    const read = (address: ReturnType<typeof addressOf.component>): string | undefined => readTranslation(controller.translations(), "fr", address)?.text;
    expect(read(addressOf.component("kind", "label"))).toBe("Genre");
    expect(read(addressOf.option("kind", "no", "label"))).toBe("Non");
    expect(read(addressOf.component("name", "label"))).toBe("Nom");
    expect(surface.pendingCount).toBe(0);
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
    expect(q(root, "[data-languages-live]").textContent).toBe("Applied 3 translations.");
    // One Undo takes all three back.
    controller.undo();
    expect(read(addressOf.component("kind", "label"))).toBeUndefined();
    expect(read(addressOf.option("kind", "no", "label"))).toBeUndefined();
    expect(read(addressOf.component("name", "label"))).toBe("Nom complet");
  });

  it("clearing a cell and applying deletes the translation", () => {
    const { root, controller } = mount();
    type(cell(root, NAME), "");
    q(root, "[data-languages-apply]").click();
    expect(readTranslation(controller.translations(), "fr", addressOf.component("name", "label"))).toBeUndefined();
  });

  it("Discard puts the boxes back", () => {
    const { surface, root } = mount();
    type(cell(root, KIND), "Genre");
    q(root, "[data-languages-discard]").click();
    expect(surface.pendingCount).toBe(0);
    expect(cell(root, KIND).value).toBe("");
  });

  it("keeps typed cells across a repaint caused by a filter", () => {
    const { surface, root } = mount();
    type(cell(root, KIND), "Genre");
    q(root, '[data-languages-group="fields"]').click();
    expect(cell(root, KIND).value).toBe("Genre");
    expect(surface.pendingCount).toBe(1);
  });

  it("is the controller's leave guard while edits pend, asking before the author goes", () => {
    const { surface, root, controller } = mount();
    expect(controller.hasPendingLeaveGuard()).toBe(false);
    type(cell(root, KIND), "Genre");
    expect(controller.hasPendingLeaveGuard()).toBe(true);
    let left = false;
    controller.requestLeave(() => {
      left = true;
    });
    expect(left).toBe(false);
    const prompt = q(root, "[data-unsaved-prompt]");
    expect(prompt.textContent).toContain("Translations not applied");
    expect(prompt.textContent).toContain("1 translation");
    // Stay keeps everything where it was.
    q(root, "[data-unsaved-stay]").click();
    expect(left).toBe(false);
    expect(surface.pendingCount).toBe(1);
    // Apply writes, then the held leave runs.
    controller.requestLeave(() => {
      left = true;
    });
    q(root, "[data-unsaved-save]").click();
    expect(left).toBe(true);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(controller.hasPendingLeaveGuard()).toBe(false);
  });

  it("lets the author discard at the guard", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    let left = false;
    controller.requestLeave(() => {
      left = true;
    });
    q(root, "[data-unsaved-discard]").click();
    expect(left).toBe(true);
    expect(surface.pendingCount).toBe(0);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
  });

  it("discardPending also drops a leave question the controller holds for the guard", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    controller.requestLeave(() => undefined);
    expect(controller.unsavedChangesPrompt()?.external?.id).toBe("languages-texts");
    expect(root.querySelector("dialog[data-prompt]")).not.toBeNull();

    surface.discardPending();

    expect(controller.unsavedChangesPrompt()).toBeUndefined();
    expect(root.querySelector("dialog[data-prompt]")).toBeNull();
    expect(surface.pendingCount).toBe(0);
  });

  it("lets go of the guard when it leaves the page", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.remove();
    expect(controller.hasPendingLeaveGuard()).toBe(false);
  });
});

describe("the goto event", () => {
  it("filters the Texts to the component and clears every other filter", () => {
    const { surface, root } = mount();
    type(q<HTMLInputElement>(root, "[data-languages-search]"), "zzz");
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "missing");
    surface.dispatchEvent(new CustomEvent("builder-languages-goto", { detail: { componentId: "kind" } }));
    expect(rowKeys(root).every((key) => key.startsWith("components/kind/"))).toBe(true);
    expect(rowKeys(root).length).toBeGreaterThan(1);
    expect(q<HTMLInputElement>(root, "[data-languages-search]").value).toBe("");
    expect(q<HTMLSelectElement>(root, "[data-languages-status]").value).toBe("all");
    expect(q(root, "[data-languages-component]").textContent).toContain("Kind");
    q(root, "[data-languages-component-clear]").click();
    expect(rowKeys(root)).toContain(NAME);
    expect(root.querySelector("[data-languages-component]")).toBeNull();
  });

  it("filters the Texts to one header or footer part when the Header & footer panel names it", () => {
    const { surface, root } = mount();
    type(q<HTMLInputElement>(root, "[data-languages-search]"), "zzz");
    surface.dispatchEvent(new CustomEvent("builder-languages-goto", { detail: { kind: "chrome", partId: "welcome" } }));
    expect(rowKeys(root)).toEqual(["chrome/welcome/text"]);
    expect(q<HTMLInputElement>(root, "[data-languages-search]").value).toBe("");
    expect(q(root, "[data-languages-component]").textContent).toContain("welcome");
    q(root, "[data-languages-component-clear]").click();
    expect(rowKeys(root)).toContain(NAME);
    expect(rowKeys(root)).toContain("chrome/welcome/text");
    expect(root.querySelector("[data-languages-component]")).toBeNull();
    // A component's goto replaces a part's, not adds to it.
    surface.dispatchEvent(new CustomEvent("builder-languages-goto", { detail: { kind: "chrome", partId: "welcome" } }));
    surface.dispatchEvent(new CustomEvent("builder-languages-goto", { detail: { componentId: "kind" } }));
    expect(rowKeys(root).every((key) => key.startsWith("components/kind/"))).toBe(true);
  });

  it("raises its own copy (show it in Form) bubbling, and does not filter on it", () => {
    const { surface, root } = mount();
    const heard: string[] = [];
    document.body.addEventListener("builder-languages-goto", (event) => heard.push((event as CustomEvent<{ componentId: string }>).detail.componentId));
    q(root, `[data-languages-row="${NAME}"] [data-languages-goto]`).click();
    expect(heard).toEqual(["name"]);
    expect(rowKeys(root).length).toBeGreaterThan(1);
    expect(surface.shadowRoot!.querySelector("[data-languages-component]")).toBeNull();
  });

  it("holds a goto that arrives before the surface has a controller", () => {
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    document.body.append(surface);
    surface.dispatchEvent(new CustomEvent("builder-languages-goto", { detail: { componentId: "kind" } }));
    surface.controller = languagesController();
    expect(rowKeys(surface.shadowRoot!).every((key) => key.startsWith("components/kind/"))).toBe(true);
  });
});

describe("the exchange dialogs", () => {
  const dialogs = (root: ParentNode): number => root.querySelectorAll("[data-languages-exchange-dialog]").length;

  it("closes the dialog it opened when the shell hides the workspace from code", () => {
    const { surface, root } = mount();
    surface.openExport();
    expect(dialogs(root)).toBe(1);
    surface.closeExchange();
    expect(dialogs(root)).toBe(0);
    // Nothing open: closing again is harmless.
    surface.closeExchange();
    surface.openImport();
    surface.openExport();
    expect(dialogs(root)).toBe(1);
  });

  it("closes the dialog it opened when it leaves the page", () => {
    const { surface, root } = mount();
    surface.openImport();
    expect(dialogs(root)).toBe(1);
    surface.remove();
    expect(dialogs(root)).toBe(0);
  });
});

describe("export and import", () => {
  it("has the two buttons, wired to the methods the exchange stage fills", () => {
    const { surface, root } = mount();
    let opened = "";
    surface.openExport = () => {
      opened += "export;";
    };
    surface.openImport = () => {
      opened += "import;";
    };
    q(root, "[data-languages-export]").click();
    q(root, "[data-languages-import]").click();
    expect(opened).toBe("export;import;");
    expect(surface.textRows.length).toBeGreaterThan(4);
  });
});

describe("a form with thousands of texts", () => {
  function manyTexts(count: number): TranslatableText[] {
    return Array.from({ length: count }, (_, index) => ({
      componentId: `f${index}`,
      componentLabel: `Field ${index}`,
      propertyPath: "label",
      label: "Label",
      default: `Label ${index}`,
      address: { kind: "components" as const, owner: `f${index}`, path: ["label"] }
    }));
  }

  function mountMany(count: number): Mounted {
    const controller = languagesController();
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.controller = controller;
    surface.extraTexts = manyTexts(count);
    document.body.append(surface);
    return { surface, controller, root: surface.shadowRoot! };
  }

  const painted = (root: ParentNode, group: string): number => root.querySelectorAll(`[data-languages-group-body="${group}"] [data-languages-row]`).length;

  it("paints at most a window of rows per group and offers Show more for the rest", () => {
    const { root, surface } = mountMany(2000);
    const group = q(root, "[data-languages-more]").closest("tbody")!.getAttribute("data-languages-group-body")!;
    expect(painted(root, group)).toBe(200);
    expect(surface.textRows.filter((row) => row.groupId === group)).toHaveLength(2000);
    expect(root.querySelectorAll("[data-languages-row]").length - painted(root, "texts")).toBeLessThan(260);
    q(root, `[data-languages-more="${group}"]`).click();
    expect(painted(root, group)).toBe(400);
    // The shown count still speaks of every match, not of the painted window.
    expect(q(root, "[data-languages-shown]").textContent).toContain("of");
  });

  it("starts the windows again when the filter changes, and paints once for three typed characters", () => {
    vi.useFakeTimers();
    try {
      const { root, surface } = mountMany(2000);
      const group = q(root, "[data-languages-more]").closest("tbody")!.getAttribute("data-languages-group-body")!;
      q(root, `[data-languages-more="${group}"]`).click();
      expect(painted(root, group)).toBe(400);
      const build = vi.spyOn(surface as unknown as { tableHtml: (columns: unknown) => string }, "tableHtml");
      const search = q<HTMLInputElement>(root, "[data-languages-search]");
      for (const text of ["1", "19", "199"]) {
        type(search, text);
        vi.advanceTimersByTime(30);
      }
      expect(build).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(build).toHaveBeenCalledTimes(1);
      expect(rowKeys(root)).toContain("components/f199/label");
      expect(painted(root, group)).toBeLessThan(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paints at once on Enter and on leaving the search box", () => {
    vi.useFakeTimers();
    try {
      const { root } = mountMany(300);
      const search = q<HTMLInputElement>(root, "[data-languages-search]");
      type(search, "Label 299");
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
      expect(rowKeys(root)).toEqual(["components/f299/label"]);
      type(q<HTMLInputElement>(root, "[data-languages-search]"), "Label 298");
      q(root, "[data-languages-search]").dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
      expect(rowKeys(root)).toEqual(["components/f298/label"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repaints only the row it confirmed, leaving the other rows' elements in place", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    const kindRow = q(root, `[data-languages-row="${KIND}"]`);
    const nameRow = q(root, `[data-languages-row="${NAME}"]`);
    q(root, `[data-languages-reconcile="${NAME}"]`).click();
    expect(q(root, `[data-languages-row="${KIND}"]`)).toBe(kindRow);
    expect(q(root, `[data-languages-row="${NAME}"]`)).not.toBe(nameRow);
    expect(cell(root, NAME).closest("td")!.classList.contains("present")).toBe(true);
    expect(root.querySelector(`[data-languages-reconcile="${NAME}"]`)).toBeNull();
  });
});

describe("the preview language follows the controller and the pending count is announced", () => {
  it("shows the controller's language even when the change skipped the surface", () => {
    const { surface, controller, root } = mount();
    surface.locale = "en";
    controller.setOptions({ locale: "fr" });
    expect(q<HTMLSelectElement>(root, "[data-languages-preview]").value).toBe("fr");
  });

  it("makes the pending count a polite live region", () => {
    const { root } = mount();
    expect(q(root, "[data-languages-pending-count]").getAttribute("aria-live")).toBe("polite");
  });
});

describe("structure for assistive technology", () => {
  function unlabelled(root: ParentNode): string[] {
    return [...root.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea")]
      .filter((control) => !control.getAttribute("aria-label") && !control.closest("label") && !(control.id && root.querySelector(`label[for="${control.id}"]`)))
      .map((control) => control.outerHTML.slice(0, 80));
  }

  it("labels every control, uses buttons for actions and one heading chain", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    q(root, '[data-languages-menu="fr"]').click();
    expect(unlabelled(root)).toEqual([]);
    const levels = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => Number(heading.tagName.slice(1)));
    expect(levels.filter((level) => level === 1)).toEqual([]);
    expect(levels[0]).toBe(2);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]! - levels[i - 1]!, `heading ${i}`).toBeLessThanOrEqual(1);
    }
    // Every clickable thing is a button; no div or span carries an action.
    const actionable = [...root.querySelectorAll<HTMLElement>("[data-languages-add],[data-languages-apply],[data-languages-discard],[data-languages-export],[data-languages-import],[data-languages-group],[data-languages-view],[data-languages-reconcile],[data-languages-menu],[data-languages-goto]")];
    expect(actionable.length).toBeGreaterThan(8);
    expect(actionable.every((element) => element.tagName === "BUTTON")).toBe(true);
    // Icon-only controls carry a name; the table has a caption and column headers.
    expect(q(root, '[data-languages-menu="fr"]').getAttribute("aria-label")).toContain("Français");
    expect(root.querySelector("table caption")).not.toBeNull();
    expect(root.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThanOrEqual(4);
    expect(root.querySelector("nav[aria-label]")).not.toBeNull();
  });

  it("leaves no id twice", () => {
    const { root } = mount();
    const ids = [...root.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the leave guard beside the Logic surface's", () => {
  function mountLogic(controller: BuilderController): HTMLElement {
    const logic = document.createElement(DATUM_BUILDER_LOGIC_TAG) as HTMLElement & { controller: BuilderController | undefined };
    logic.controller = controller;
    document.body.append(logic);
    return logic;
  }

  it("stacks its guard, so Logic's stays in the slot after an Apply", () => {
    const controller = languagesController();
    mountLogic(controller);
    const logicGuard = controller.leaveGuardInForce();
    expect(logicGuard).toBeDefined();
    const { root } = mount(controller);
    type(cell(root, KIND), "Genre");
    expect(controller.leaveGuardSubject()).toBe("languages-texts");
    q(root, "[data-languages-apply]").click();
    expect(controller.leaveGuardInForce()).toBe(logicGuard);
    expect(controller.hasPendingLeaveGuard()).toBe(false);
  });

  it("keeps holding its typed cells when the Logic surface connects after it", () => {
    const controller = languagesController();
    const { root, surface } = mount(controller);
    type(cell(root, KIND), "Genre");
    mountLogic(controller);
    expect(controller.hasPendingLeaveGuard()).toBe(true);
    expect(controller.leaveGuardSubject()).toBe("languages-texts");
    // Gone from the page, it takes only its own guard away.
    const logicGuard = controller.leaveGuardInForce();
    surface.remove();
    expect(controller.hasPendingLeaveGuard()).toBe(false);
    expect(controller.leaveGuardInForce()).toBe(logicGuard);
  });
});

describe("another document in the same controller", () => {
  it("drops the cells typed for the last one, and Apply has nothing to write into the new one", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre tapé");
    q(root, '[data-languages-rename="fr"]').click();
    expect(surface.pendingCount).toBe(1);
    controller.setOptions({ initialRoot: languagesRoot() });
    expect(surface.pendingCount).toBe(0);
    expect(controller.hasPendingLeaveGuard()).toBe(false);
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
    expect(cell(root, KIND).value).toBe("");
    expect(root.querySelector("[data-languages-rename-form]")).toBeNull();
    q(root, "[data-languages-apply]").click();
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
  });
});

describe("while the shell hides the surface", () => {
  it("draws nothing for a change made elsewhere, and draws it once when shown again", () => {
    const { surface, root, controller } = mount();
    const paint = vi.spyOn(surface as unknown as { paint: () => void }, "paint");
    const compute = vi.spyOn(surface as unknown as { computeTexts: () => unknown }, "computeTexts");
    surface.shown = false;
    controller.setProperty("name", "label", "Your name");
    controller.setProperty("kind", "label", "Sort");
    expect(compute).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    expect(cell(root, NAME).closest("td")!.classList.contains("stale")).toBe(false);
    surface.shown = true;
    expect(paint).toHaveBeenCalledTimes(1);
    expect(cell(root, NAME).closest("td")!.classList.contains("stale")).toBe(true);
  });

  it("still lets go of a typed cell whose text went, so the guard never names it", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.shown = false;
    controller.remove("kind");
    expect(surface.pendingCount).toBe(0);
    expect(controller.hasPendingLeaveGuard()).toBe(false);
  });

  it("draws a Discard answered while hidden when shown again", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.shown = false;
    controller.requestLeave(() => undefined);
    controller.answerUnsavedChangesPrompt("discard");
    surface.shown = true;
    expect(cell(root, KIND).value).toBe("");
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
  });
});

describe("the shell handing the same inputs again (one visit)", () => {
  it("paints nothing when nothing it draws from changed, and once when a text did", () => {
    const { surface, root, controller } = mount();
    const paint = vi.spyOn(surface as unknown as { paint: () => void }, "paint");
    const feed = (texts: TranslatableText[]): void => {
      surface.definition = () => undefined;
      surface.hostCatalog = false;
      surface.translationCatalog = undefined;
      surface.extraTexts = () => texts;
      surface.pdfTexts = () => [];
      surface.locale = controller.currentLocale();
      surface.controller = controller;
    };
    feed([]);
    expect(paint).not.toHaveBeenCalled();
    surface.shown = false;
    feed([{ componentId: "j", componentLabel: "Journey", propertyPath: "title", label: "Title", default: "Start", address: { kind: "components", owner: "j", path: ["title"] } }]);
    expect(paint).not.toHaveBeenCalled();
    surface.shown = true;
    expect(paint).toHaveBeenCalledTimes(1);
    expect(rowKeys(root)).toContain("components/j/title");
    surface.hostCatalog = true;
    expect(root.querySelector("[data-languages-catalog-note]")).not.toBeNull();
  });
});

describe("names written while focus moves on", () => {
  it("names a language in place: the card's elements and the cells stay, their names follow", () => {
    const { root, controller } = mount();
    const menu = q(root, '[data-languages-menu="fr"]');
    const box = cell(root, NAME);
    const label = q<HTMLInputElement>(root, '[data-languages-label="fr"]');
    label.focus();
    label.value = "Français canadien";
    label.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(controller.localization()?.supportedLocales?.find((entry) => typeof entry !== "string" && entry.code === "fr")).toMatchObject({ label: "Français canadien" });
    expect(q(root, '[data-languages-menu="fr"]')).toBe(menu);
    expect(menu.getAttribute("aria-label")).toContain("Français canadien");
    expect(q(root, '[data-languages-label="fr"]')).toBe(label);
    expect(cell(root, NAME)).toBe(box);
    expect(box.getAttribute("aria-label")).toContain("Français canadien");
    expect(q(root, 'thead th[lang="fr"]').textContent).toContain("Français canadien");
    expect(q(root, '[data-languages-preview] option[value="fr"]').textContent).toBe("Français canadien");
    // The next change elsewhere finds nothing new to draw.
    controller.select("name");
    expect(q(root, '[data-languages-menu="fr"]')).toBe(menu);
  });

  it("labels the switcher in place, keeping the Preview language select the Tab goes to", () => {
    const { root, controller } = mount();
    const preview = q(root, "[data-languages-preview]");
    const place = q(root, "[data-languages-switcher-place]");
    const box = q<HTMLInputElement>(root, "[data-languages-switcher-label]");
    box.value = "Langue";
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(switcherState(chromeOf(controller)).label).toBe("Langue");
    expect(q(root, "[data-languages-preview]")).toBe(preview);
    expect(q(root, "[data-languages-switcher-place]")).toBe(place);
    expect(q(root, '[data-languages-lang="fr"]')).toBeTruthy();
    // The label is a text of its own now, listed under Header & footer.
    expect(rowKeys(root)).toContain("chrome/switcher/label");
  });
});

describe("focus after an action that takes its own button away", () => {
  it("Make default leaves focus on the card's menu button", () => {
    const { root } = mount();
    q(root, '[data-languages-default="fr"]').click();
    const confirm = q(root, "[data-languages-default-confirm]");
    confirm.focus();
    confirm.click();
    expect(root.activeElement).toBe(q(root, '[data-languages-menu="fr"]'));
  });

  it("Confirm moves on to the next Confirm, then to the cell, then to the filter that shows nothing", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    controller.setProperty("root", "title", "Permit form");
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "stale");
    expect(rowKeys(root)).toEqual([TITLE, NAME]);
    const first = q(root, `[data-languages-reconcile="${TITLE}"]`);
    first.focus();
    first.click();
    expect(root.activeElement).toBe(q(root, `[data-languages-reconcile="${NAME}"]`));
    (root.activeElement as HTMLElement).click();
    expect(rowKeys(root)).toEqual([]);
    expect(root.activeElement).toBe(q(root, "[data-languages-status]"));
  });

  it("Confirm on the last one with every text shown leaves focus on its cell", () => {
    const { root, controller } = mount();
    controller.setProperty("name", "label", "Your name");
    const confirm = q(root, `[data-languages-reconcile="${NAME}"]`);
    confirm.focus();
    confirm.click();
    expect(root.activeElement).toBe(cell(root, NAME));
  });
});

describe("the one-language view's last text", () => {
  it("says done when a filter, not a window, hides the rest", () => {
    const controller = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "de" }], defaultLocale: "en" });
    const { root } = mount(controller);
    q(root, '[data-languages-view="one"]').click();
    q(root, '[data-languages-group="fields"]').click();
    expect(root.querySelector("[data-languages-more]")).toBeNull();
    const boxes = [...root.querySelectorAll<HTMLInputElement>("input[data-languages-cell]")];
    const last = boxes[boxes.length - 1]!;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(q(root, "[data-languages-live]").textContent).toBe("Nothing more here needs a translation.");
  });
});

describe("why a code is refused, in the builder's words", () => {
  it("answers the reason as data, and the agent's English from it", () => {
    expect(languageCodeIssue("", undefined)).toEqual({ code: "empty" });
    expect(languageCodeIssue(" pas un code ", undefined)).toEqual({ code: "pattern", value: "pas un code" });
    expect(languageCodeIssue("FR", { supportedLocales: [{ code: "fr" }] })).toEqual({ code: "taken", value: "FR" });
    expect(languageRenameIssue("fr", "en", { supportedLocales: [{ code: "en" }, { code: "fr" }] })).toEqual({ code: "taken", value: "en" });
    expect(languageCodeProblem("pas un code", undefined)).toBe('"pas un code" is not a language code (e.g. "en" or "fr-CA").');
  });

  it("words the Add box's problem through the host's catalog", () => {
    const { surface, root } = mount();
    surface.textCatalog = { fr: { "languages.code.problem.pattern": "« {value} » n'est pas un code de langue." } };
    surface.textLocale = "fr";
    type(q<HTMLInputElement>(root, "[data-languages-add-code]"), "pas un code");
    q(root, "[data-languages-add]").click();
    expect(q(root, "#languages-add-problem").textContent).toBe("« pas un code » n'est pas un code de langue.");
  });

  it("words the Rename box's problem through the text table", () => {
    const { root } = mount();
    q(root, '[data-languages-rename="fr"]').click();
    type(q<HTMLInputElement>(root, "[data-languages-rename-code]"), "en");
    q(root, "[data-languages-rename-confirm]").click();
    expect(q(root, "#languages-rename-problem").textContent).toBe("“en” is already one of the form's languages.");
  });
});

describe("the card menu (a disclosure)", () => {
  function focusOut(from: HTMLElement, to: HTMLElement | null): void {
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: to }));
  }

  it("does not claim to be a popup menu", () => {
    const { root } = mount();
    expect(q(root, '[data-languages-menu="fr"]').hasAttribute("aria-haspopup")).toBe(false);
    expect(q(root, '[data-languages-menu="fr"]').getAttribute("aria-controls")).toBe("languages-menu-fr");
  });

  it("closes in place when focus leaves it, and stays open for focus inside it or going nowhere", () => {
    const { root } = mount();
    const button = q(root, '[data-languages-menu="fr"]');
    button.click();
    const menu = q(root, "#languages-menu-fr");
    const rename = q(root, '[data-languages-rename="fr"]');
    expect(menu.hasAttribute("hidden")).toBe(false);
    focusOut(q(root, '[data-languages-menu="fr"]'), rename);
    expect(menu.hasAttribute("hidden")).toBe(false);
    focusOut(rename, null);
    expect(menu.hasAttribute("hidden")).toBe(false);
    focusOut(rename, cell(root, NAME));
    expect(menu.hasAttribute("hidden")).toBe(true);
    expect(q(root, '[data-languages-menu="fr"]').getAttribute("aria-expanded")).toBe("false");
    // Closed without a repaint: the elements focus was moving between are the same ones.
    expect(q(root, "#languages-menu-fr")).toBe(menu);
    expect(q(root, '[data-languages-rename="fr"]')).toBe(rename);
  });
});

describe("focus once Apply or Discard takes the pending bar away", () => {
  it("Apply in the bar leaves focus on the cell typed into last", () => {
    const { root } = mount();
    type(cell(root, KIND), "Genre");
    type(cell(root, NAME), "Nom");
    const apply = q(root, "[data-languages-apply]");
    apply.focus();
    apply.click();
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
    expect(root.activeElement).toBe(cell(root, NAME));
  });

  it("Discard in the bar leaves focus on the cell typed into last", () => {
    const { root } = mount();
    type(cell(root, NAME), "Nom");
    type(cell(root, KIND), "Genre");
    const discard = q(root, "[data-languages-discard]");
    discard.focus();
    discard.click();
    expect(root.activeElement).toBe(cell(root, KIND));
  });

  it("goes to the search box when a filter hides that cell", () => {
    const { root } = mount();
    type(cell(root, KIND), "Genre");
    q(root, '[data-languages-group="options"]').click();
    expect(root.querySelector(`[data-languages-cell="${KIND}"]`)).toBeNull();
    const discard = q(root, "[data-languages-discard]");
    discard.focus();
    discard.click();
    expect(root.activeElement).toBe(q(root, "[data-languages-search]"));
  });

  it("the leave question's Apply and Discard leave focus on that cell too", () => {
    for (const answer of ["save", "discard"] as const) {
      const { root, controller } = mount();
      type(cell(root, KIND), "Genre");
      controller.requestLeave(() => undefined);
      const button = q(root, `[data-unsaved-${answer}]`);
      button.focus();
      button.click();
      expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
      expect(root.activeElement).toBe(cell(root, KIND));
      document.body.innerHTML = "";
    }
  });

  it("holds after a mouse click that left focus on the page's body (Safari, Firefox on macOS)", () => {
    for (const button of ["apply", "discard"] as const) {
      const { root } = mount();
      const box = cell(root, KIND);
      box.focus();
      type(box, "Genre");
      box.blur();
      expect(root.activeElement).toBeNull();
      q(root, `[data-languages-${button}]`).click();
      expect(root.activeElement).toBe(cell(root, KIND));
      document.body.innerHTML = "";
    }
  });

  it("the leave question's buttons clicked with the mouse leave focus on that cell", () => {
    const { root, controller } = mount();
    type(cell(root, KIND), "Genre");
    controller.requestLeave(() => undefined);
    (document.activeElement as HTMLElement | null)?.blur();
    q(root, "[data-unsaved-save]").click();
    expect(root.activeElement).toBe(cell(root, KIND));
  });

  it("leaves focus alone for an Apply asked from outside the surface", () => {
    const { root, controller } = mount();
    type(cell(root, KIND), "Genre");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    controller.requestLeave(() => undefined);
    controller.answerUnsavedChangesPrompt("save");
    expect(root.activeElement).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});

describe("Import while typed cells wait", () => {
  const importDialog = (root: ShadowRoot): HTMLDialogElement | null => root.querySelector<HTMLDialogElement>('dialog[data-languages-exchange-dialog="import"]');

  it("asks Apply or Discard first, then imports against the applied text", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    q(root, "[data-languages-import]").click();
    expect(importDialog(root)).toBeNull();
    const prompt = q(root, "[data-unsaved-prompt]");
    expect(prompt.textContent).toContain("Apply or discard it before importing translations.");
    q(root, "[data-unsaved-save]").click();
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(surface.pendingCount).toBe(0);
    expect(importDialog(root)).not.toBeNull();
  });

  it("Discard drops the typing, then opens Import", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.openImport();
    q(root, "[data-unsaved-discard]").click();
    expect(surface.pendingCount).toBe(0);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
    expect(importDialog(root)).not.toBeNull();
  });

  it("puts the question away when the leave guard discards from elsewhere", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.openImport();
    expect(root.querySelector("[data-unsaved-prompt]")).not.toBeNull();
    let left = false;
    controller.requestLeave(() => {
      left = true;
    });
    controller.answerUnsavedChangesPrompt("discard");
    expect(left).toBe(true);
    expect(surface.pendingCount).toBe(0);
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(importDialog(root)).toBeNull();
  });

  it("puts the question away when an Apply settles the typing", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.openImport();
    controller.requestLeave(() => undefined);
    controller.answerUnsavedChangesPrompt("save");
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
  });

  it("puts the question away when the shell hides the workspace, and does not ask it again", () => {
    const { surface, root } = mount();
    type(cell(root, KIND), "Genre");
    surface.openImport();
    expect(root.querySelector("[data-unsaved-prompt]")).not.toBeNull();
    surface.closeExchange();
    expect(root.querySelector("dialog[data-prompt]")).toBeNull();
    // A repaint that settles nothing draws no question: it is not held any more.
    q(root, '[data-languages-group="fields"]').click();
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(surface.pendingCount).toBe(1);
  });

  it("Stay, or Escape, keeps the typing and opens nothing", () => {
    const { surface, root } = mount();
    type(cell(root, KIND), "Genre");
    q(root, "[data-languages-import]").click();
    q(root, "[data-unsaved-stay]").click();
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(importDialog(root)).toBeNull();
    expect(surface.pendingCount).toBe(1);
    expect(cell(root, KIND).value).toBe("Genre");
    expect(root.activeElement).toBe(cell(root, KIND));
    q(root, "[data-languages-import]").click();
    q(root, "dialog[data-prompt]").dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(root.querySelector("[data-unsaved-prompt]")).toBeNull();
    expect(importDialog(root)).toBeNull();
    expect(surface.pendingCount).toBe(1);
  });
});

describe("discardPending (the host takes the workspace away)", () => {
  it("drops the typed cells, lets go of the guard and puts the question away", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    surface.openImport();
    expect(controller.hasPendingLeaveGuard()).toBe(true);
    surface.discardPending();
    expect(surface.pendingCount).toBe(0);
    expect(controller.hasPendingLeaveGuard()).toBe(false);
    expect(root.querySelector("dialog[data-prompt]")).toBeNull();
    expect(cell(root, KIND).value).toBe("");
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
  });

  it("changes nothing with nothing typed, and is drawn when shown again after a hidden discard", () => {
    const { surface, root } = mount();
    const before = cell(root, KIND);
    surface.discardPending();
    expect(cell(root, KIND)).toBe(before);
    type(cell(root, KIND), "Genre");
    surface.shown = false;
    surface.discardPending();
    expect(surface.pendingCount).toBe(0);
    surface.shown = true;
    expect(cell(root, KIND).value).toBe("");
  });
});

describe("a regional language its base language serves", () => {
  const regional = (): BuilderController =>
    languagesController({ supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "fr-CA" }], defaultLocale: "en" });

  it("shows the base language's text as what the form shows, editable, and counts it as translated", () => {
    const { root } = mount(regional());
    const box = cell(root, NAME, "fr-CA");
    expect(box.value).toBe("");
    expect(box.readOnly).toBe(false);
    expect(box.closest("td")!.getAttribute("data-status")).toBe("present");
    expect(q(box.closest("td")!, "[data-languages-fallback-wording]").textContent).toBe("Shows the Français text “Nom complet” until you translate it.");
    expect(box.closest("td")!.querySelector("[data-languages-page-wording]")).toBeNull();
    expect(q(root, '[data-languages-lang-coverage="fr-CA"]').textContent).toBe(q(root, '[data-languages-lang-coverage="fr"]').textContent);
    choose(q<HTMLSelectElement>(root, "[data-languages-status]"), "missing");
    expect(root.querySelector(`[data-languages-cell="${NAME}"][data-languages-locale="fr-CA"]`)?.closest("td")?.getAttribute("data-status")).not.toBe("missing");
  });

  it("drops the note once the cell has a text of its own, and brings it back when cleared", () => {
    const { root } = mount(regional());
    const box = cell(root, NAME, "fr-CA");
    type(box, "Nom au complet");
    expect(box.closest("td")!.querySelector("[data-languages-fallback-wording]")).toBeNull();
    type(box, "");
    expect(box.closest("td")!.querySelector("[data-languages-fallback-wording]")).not.toBeNull();
  });
});

describe("Undo and Redo keys in the surface", () => {
  function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, composed: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("steps the form's history, not the box's, and leaves the typed cells as they are", () => {
    const { surface, root, controller } = mount();
    type(cell(root, KIND), "Genre");
    q(root, "[data-languages-apply]").click();
    type(cell(root, NAME), "Nom à moi");
    const undo = press(cell(root, NAME), { key: "z", ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))).toBeUndefined();
    expect(surface.pendingCount).toBe(1);
    expect(cell(root, NAME).value).toBe("Nom à moi");
    const redo = press(cell(root, NAME), { key: "Z", metaKey: true, shiftKey: true });
    expect(redo.defaultPrevented).toBe(true);
    expect(readTranslation(controller.translations(), "fr", addressOf.component("kind", "label"))?.text).toBe("Genre");
    expect(surface.pendingCount).toBe(1);
  });

  it("goes through the shell's historyStep when it set one: Z undoes, Shift+Z and Y redo", () => {
    const { surface, root, controller } = mount();
    const steps: string[] = [];
    surface.historyStep = (given, direction) => {
      expect(given).toBe(controller);
      steps.push(direction);
    };
    const undo = vi.spyOn(controller, "undo");
    press(q(root, "[data-languages-search]"), { key: "z", ctrlKey: true });
    press(q(root, '[data-languages-menu="fr"]'), { key: "z", metaKey: true, shiftKey: true });
    press(q(root, "[data-languages-status]"), { key: "y", ctrlKey: true });
    expect(steps).toEqual(["undo", "redo", "redo"]);
    expect(undo).not.toHaveBeenCalled();
  });

  it("writes a switcher label typed and not yet left before the step, so the Undo takes that typing back", () => {
    const { surface, root, controller } = mount();
    let labelAtStep: string | undefined;
    surface.historyStep = () => {
      labelAtStep = switcherState(chromeOf(controller)).label;
    };
    const box = q<HTMLInputElement>(root, "[data-languages-switcher-label]");
    box.focus();
    type(box, "Langue");
    expect(switcherState(chromeOf(controller)).label).toBe("");
    press(box, { key: "z", ctrlKey: true });
    expect(labelAtStep).toBe("Langue");
  });

  it("leaves the keys to a dialog over the page", () => {
    const { surface, root } = mount();
    const steps: string[] = [];
    surface.historyStep = (_controller, direction) => steps.push(direction);
    type(cell(root, KIND), "Genre");
    surface.openImport();
    const event = press(q(root, "[data-unsaved-stay]"), { key: "z", ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(steps).toEqual([]);
  });
});
