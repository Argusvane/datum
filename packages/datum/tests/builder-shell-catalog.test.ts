import { afterEach, describe, expect, it } from "vitest";
import { BUILDER_TEXTS_EN, type BuilderTextCatalog } from "../../../engine/form-engine/builder/logic/builder-texts.js";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The shell chrome joins the builder text catalog: the strip, the Outline, Components, Variables, Settings, View, Header and footer
 * panels and the Data and Languages surfaces take their words from textLocale/textCatalog, and
 * read as English when the host sets nothing.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const catalog: BuilderTextCatalog = {
  fr: {
    "shell.panel.outline.label": "Plan",
    "shell.panel.outline.title": "Plan du formulaire",
    "shell.panel.chrome.short": "En-tête",
    "shell.panel.variables.label": "Variables du formulaire",
    "shell.command.showPanel": "Afficher le panneau {panel}",
    "outline.title": "Plan",
    "components.title": "Composants",
    "components.filter.placeholder": "Filtrer les composants…",
    "variables.title": "Variables du formulaire",
    "variables.filter.placeholder": "Filtrer",
    "settings.title": "Réglages",
    "settings.submit.hint": "Ces valeurs servent à Essayer, dans Formulaire, Logique, Parcours et PDF.",
    "view.title": "Affichage",
    "chrome.title": "En-tête et pied de page",
    "chrome.tab.parts": "Éléments",
    "data.title": "Schéma des réponses",
    "data.view.schema": "Schéma JSON",
    "languages.title": "Langues",
    "languages.add.title": "Ajouter une langue",
    "languages.switcher.title": "Sélecteur de langue",
    "languages.texts.title": "Textes"
  }
};

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const panelRoot = (element: DatumFormBuilderElement, selector: string): ShadowRoot => shell(element).querySelector(selector)!.shadowRoot!;
const stripItem = (element: DatumFormBuilderElement, id: string): HTMLElement => shell(element).querySelector<HTMLElement>(`[data-strip] [data-panel="${id}"]`)!;

async function mount(withCatalog: boolean): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  if (withCatalog) {
    element.textCatalog = catalog;
    element.textLocale = "fr";
  }
  return element;
}

describe("the shell chrome and the builder text catalog", () => {
  it("reads as today's English when the host sets no catalog", async () => {
    const element = await mount(false);
    expect(stripItem(element, "outline").getAttribute("aria-label")).toBe("Outline");
    expect(stripItem(element, "chrome").getAttribute("aria-label")).toBe("Header and footer");
    expect(stripItem(element, "chrome").getAttribute("data-tip")).toBe("Header & footer");
    expect(stripItem(element, "chrome").querySelector(".strip-label")!.textContent).toBe("Header");
    expect(stripItem(element, "form").getAttribute("aria-label")).toBe("Form settings");
    element.builder!.panel = "outline";
    expect(panelRoot(element, ".outline").querySelector(".card-title")!.textContent).toBe("Outline");
    element.builder!.panel = "variables";
    // The panel's body is a chunk of its own, fetched on its first open.
    await until(() => panelRoot(element, ".variables")?.querySelector(".variables-head"));
    expect(panelRoot(element, ".variables").querySelector(".variables-head")!.textContent).toBe("Variables");
    element.builder!.panel = "components";
    expect(panelRoot(element, ".toolbar").querySelector(".panel-title")!.textContent).toBe("Components");
  });

  it("keeps every data-t text in the wrapper's markup equal to its English catalog entry", async () => {
    const element = await mount(false);
    const marked = shell(element).querySelectorAll<HTMLElement>("[data-t]");
    expect(marked.length).toBeGreaterThan(30);
    for (const node of marked) {
      const key = node.dataset.t as keyof typeof BUILDER_TEXTS_EN;
      expect(BUILDER_TEXTS_EN[key], key).toBeDefined();
      expect(node.textContent, key).toBe(BUILDER_TEXTS_EN[key]);
    }
    for (const node of shell(element).querySelectorAll<HTMLElement>("[data-t-attr]")) {
      for (const pair of node.dataset.tAttr!.split(";")) {
        const [name, key] = pair.split(":");
        expect(node.getAttribute(name!), pair).toBe(BUILDER_TEXTS_EN[key as keyof typeof BUILDER_TEXTS_EN]);
      }
    }
  });

  it("translates a strip item's name, tooltip and bottom-bar word, without a canvas repaint", async () => {
    const element = await mount(false);
    const canvas = shell(element).querySelector("datum-builder-canvas")!;
    const before = canvas.shadowRoot!.innerHTML;
    element.textCatalog = catalog;
    element.textLocale = "fr";
    const outline = stripItem(element, "outline");
    expect(outline.getAttribute("aria-label")).toBe("Plan");
    expect(outline.getAttribute("data-tip")).toBe("Plan du formulaire");
    expect(outline.querySelector(".strip-label")!.textContent).toBe("Plan");
    expect(stripItem(element, "chrome").querySelector(".strip-label")!.textContent).toBe("En-tête");
    // A key the catalog lacks falls back to English.
    expect(stripItem(element, "view").getAttribute("aria-label")).toBe("View");
    expect(canvas.shadowRoot!.innerHTML).toBe(before);
    element.textLocale = undefined;
    element.textCatalog = undefined;
    expect(outline.getAttribute("aria-label")).toBe("Outline");
  });

  it("translates the Show the X panel command", async () => {
    const element = await mount(true);
    const commands = (): Array<{ id: string; label: string }> => (element.builder as unknown as { paletteCommands(): Array<{ id: string; label: string }> }).paletteCommands();
    expect(commands().find((entry) => entry.id === "view:outline")?.label).toBe("Afficher le panneau Plan");
    element.textLocale = undefined;
    element.textCatalog = undefined;
    expect(commands().find((entry) => entry.id === "view:outline")?.label).toBe("Show the Outline panel");
  });

  it("translates a heading in each panel: Outline, Components, Variables, Settings, View", async () => {
    const element = await mount(true);
    element.builder!.panel = "outline";
    expect(panelRoot(element, ".outline").querySelector(".card-title")!.textContent).toBe("Plan");
    element.builder!.panel = "components";
    expect(panelRoot(element, ".toolbar").querySelector(".panel-title")!.textContent).toBe("Composants");
    expect(panelRoot(element, ".toolbar").querySelector<HTMLInputElement>("[data-palette-filter]")!.placeholder).toBe("Filtrer les composants…");
    element.builder!.panel = "variables";
    await until(() => panelRoot(element, ".variables")?.querySelector(".variables-head"));
    expect(panelRoot(element, ".variables").querySelector(".variables-head")!.textContent).toBe("Variables du formulaire");
    expect(shell(element).querySelector("[data-settings-panel] .card-title")!.textContent).toBe("Réglages");
    expect(shell(element).querySelector("[data-view-panel] .card-title")!.textContent).toBe("Affichage");
  });

  it("gives the Settings simulator section a hint that Try it uses its values", async () => {
    const english = await mount(false);
    const hint = shell(english).querySelector("[data-settings-submit] h3 + p");
    expect(hint!.textContent).toBe("These values are what Try it uses, in Form, Logic, Journeys and PDF.");
    expect(hint!.classList.contains("view-note")).toBe(true);
    document.body.innerHTML = "";
    const french = await mount(true);
    expect(shell(french).querySelector("[data-settings-submit] h3 + p")!.textContent).toBe("Ces valeurs servent à Essayer, dans Formulaire, Logique, Parcours et PDF.");
  });

  it("translates the Header and footer panel", async () => {
    const element = await mount(true);
    element.builder!.panel = "chrome";
    // The panel's body is a chunk of its own, fetched on its first open.
    await until(() => panelRoot(element, ".chrome-settings")?.querySelector(".panel-title"));
    const root = panelRoot(element, ".chrome-settings");
    expect(root.querySelector(".panel-title")!.textContent).toBe("En-tête et pied de page");
    expect(root.querySelector("[data-chrome-tab=parts]")!.textContent).toBe("Éléments");
    // Untranslated words stay English.
    expect(root.querySelector("[data-chrome-add='']")!.textContent).toBe("Add part");
  });

  it("translates the Data surface", async () => {
    const element = await mount(true);
    element.builder!.setWorkspace("data");
    await until(() => shell(element).querySelector("datum-builder-data")?.shadowRoot?.querySelector("[data-data-row]"));
    const root = panelRoot(element, "datum-builder-data");
    expect(root.querySelector("#data-title")!.textContent).toBe("Schéma des réponses");
    expect(root.querySelector("[data-data-view=schema]")!.textContent).toBe("Schéma JSON");
    expect(root.querySelector("[data-data-view=table]")!.textContent).toBe("Table");
    element.textLocale = undefined;
    element.textCatalog = undefined;
    expect(root.querySelector("#data-title")!.textContent).toBe("Schema");
  });

  it("translates the Languages surface", async () => {
    const element = await mount(true);
    element.builder!.setWorkspace("languages");
    await until(() => shell(element).querySelector("datum-builder-languages")?.shadowRoot?.querySelector("#languages-title"));
    const root = panelRoot(element, "datum-builder-languages");
    expect(root.querySelector("#languages-title")!.textContent).toBe("Langues");
    expect(root.querySelector("#languages-add-title")!.textContent).toBe("Ajouter une langue");
    expect(root.querySelector("#languages-switcher-title")!.textContent).toBe("Sélecteur de langue");
    element.textLocale = undefined;
    element.textCatalog = undefined;
    expect(root.querySelector("#languages-title")!.textContent).toBe("Languages");
  });
  it("translates the bar, the workspace tabs, the file menu and the palette's commands written by code", async () => {
    const element = await mount(false);
    element.fileActions = { new: () => undefined, save: () => undefined };
    element.textCatalog = {
      fr: {
        "shell.bar.undo": "Annuler",
        "shell.bar.undo.tip": "Annuler (Cmd/Ctrl+Z)",
        "shell.bar.workspace": "Espace de travail",
        "shell.workspace.logic": "Logique",
        "shell.file.new": "Nouveau formulaire",
        "shell.file.save": "Enregistrer",
        "shell.command.workspace": "Aller à l'espace {workspace}",
        "shell.bar.fullWindow": "Plein écran"
      }
    };
    element.textLocale = "fr";
    const root = shell(element);
    expect(root.querySelector("[data-undo]")!.getAttribute("aria-label")).toBe("Annuler");
    expect(root.querySelector("[data-undo]")!.getAttribute("data-tip")).toBe("Annuler (Cmd/Ctrl+Z)");
    expect(root.querySelector("[data-workspaces-nav]")!.getAttribute("aria-label")).toBe("Espace de travail");
    expect(root.querySelector("[data-workspace-tab=logic]")!.textContent).toBe("Logique");
    expect(root.querySelector("[data-workspace-tab=form]")!.textContent).toBe("Form");
    expect(root.querySelector("[data-file-new] .file-item-label")!.textContent).toBe("Nouveau formulaire");
    expect(root.querySelector("[data-file-save] .file-item-label")!.textContent).toBe("Enregistrer");
    expect(root.querySelector("[data-full-window]")!.getAttribute("aria-label")).toBe("Plein écran");
    const commands = (element.builder as unknown as { paletteCommands(): Array<{ id: string; label: string }> }).paletteCommands();
    expect(commands.find((entry) => entry.id === "workspace:logic")?.label).toBe("Aller à l'espace Logique");
    element.textLocale = undefined;
    element.textCatalog = undefined;
    expect(root.querySelector("[data-undo]")!.getAttribute("aria-label")).toBe("Undo");
    expect(root.querySelector("[data-workspace-tab=logic]")!.textContent).toBe("Logic");
    expect(root.querySelector("[data-file-save] .file-item-label")!.textContent).toBe("Save");
  });

  it("lists the form's header and footer texts for a host's catalog", async () => {
    const element = document.createElement("datum-form-builder");
    const definition = sampleDefinition();
    definition.root.configuration = { ...(definition.root.configuration ?? {}), chrome: { header: [{ id: "welcome", type: "heading", text: "Welcome" }] } };
    element.definition = definition;
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const texts = element.builder!.translatableTexts();
    const welcome = texts.find((text) => text.propertyPath === "chrome.header.0.text");
    expect(welcome?.default).toBe("Welcome");
    // Addressed by the part's id, not its place.
    expect(welcome?.address).toEqual({ kind: "chrome", owner: "welcome", path: ["text"] });
  });
});
