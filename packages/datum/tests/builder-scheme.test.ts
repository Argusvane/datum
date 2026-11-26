import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumBuilderElement, DatumFormBuilderElement } from "../src/builder.js";
import { DATUM_DARK_BUILDER_THEME, SCHEME_MEMORY_KEY, STUDIO_DARK_TOKENS, panelMemoryStore } from "@argusvane/datum-engine";
import { themes } from "../src/themes.js";

import { modesReady, sampleDefinition, until } from "./helpers.js";

/**
 * The builder's dark mode: the studio look's dark palette as a builder theme, switched
 * from the ⋮ menu's Dark mode item (a switch in the phone drawer), applied as --db-* vars on the
 * wrap and every panel host, remembered for the origin, forwarded and reflected by
 * `<datum-form-builder>`. jsdom lays nothing out, so these read the inline vars the shell
 * writes, which is what the stylesheet would resolve.
 */

/** The store the shell remembers into: the page's store(), or its stand-in where jsdom has none. */
const store = () => panelMemoryStore();

beforeEach(() => {
  store().removeItem(SCHEME_MEMORY_KEY);
});

afterEach(() => {
  document.body.innerHTML = "";
  store().removeItem(SCHEME_MEMORY_KEY);
});

async function mount(prepare?: (el: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder") as DatumFormBuilderElement;
  element.definition = sampleDefinition();
  prepare?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector('[data-shell="bar"]'));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const q = <T extends HTMLElement = HTMLElement>(element: DatumFormBuilderElement, selector: string): T => shell(element).querySelector<T>(selector)!;
/** The shell's host: where applyTheme writes the vars (with every panel host), which the wrap inherits. */
const wrap = (element: DatumFormBuilderElement): HTMLElement => element.builder!;
/** The shell's own stylesheet text, as the page ships it (shadow <style> elements). */
const shellCss = (element: DatumFormBuilderElement): string =>
  [...shell(element).querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
const surfaceVar = (el: HTMLElement): string => el.style.getPropertyValue("--db-surface");

describe("the builder's dark mode", () => {
  it("ships the dark palette as the datum-dark builder theme, registered on the page", () => {
    expect(themes.resolveBuilder("datum-dark")).toEqual(DATUM_DARK_BUILDER_THEME);
    expect(themes.builderThemes().map((theme) => theme.id)).toContain("datum-dark");
  });

  it("offers Dark mode in the ⋮ menu even without file actions, and the switch applies the dark tokens to the wrap and every panel", async () => {
    const element = await mount((el) => el.setAttribute("file-actions", "off"));
    const group = q(element, "[data-file-actions]");
    expect(group.hidden).toBe(false);
    const item = q(element, "[data-file-scheme]");
    expect(item.hidden).toBe(false);
    // An item that names the scheme it switches to, under a moon while light is on.
    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.querySelector(".file-item-label")?.textContent).toBe("Dark mode");
    expect(q(element, "[data-file-scheme-moon]").hidden).toBe(false);
    expect(q(element, "[data-file-scheme-sun]").hidden).toBe(true);
    // The attribute alone shows nothing in a browser: .file-item .glyph sets display, so the
    // shell's CSS must let [hidden] win or the item draws both icons (jsdom cannot see that).
    expect(shellCss(element)).toContain(".file-item .glyph[hidden] { display: none; }");
    // No file item above it: no rule above it either.
    expect(q(element, "[data-file-scheme-sep]").hidden).toBe(true);
    expect(surfaceVar(wrap(element))).toBe("");

    const heard: string[] = [];
    element.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme));
    q(element, "[data-file-menu]").click();
    expect(q(element, "[data-file-menu-list]").hidden).toBe(false);
    item.click();
    await until(() => element.builder!.scheme === "dark");
    expect(element.builder!.getAttribute("scheme")).toBe("dark");
    expect(element.getAttribute("scheme")).toBe("dark");
    expect(element.scheme).toBe("dark");
    expect(heard).toEqual(["dark"]);
    // The menu is put away by the choice; the item now offers the way back, under a sun.
    expect(q(element, "[data-file-menu-list]").hidden).toBe(true);
    expect(item.querySelector(".file-item-label")?.textContent).toBe("Light mode");
    expect(q(element, "[data-file-scheme-moon]").hidden).toBe(true);
    expect(q(element, "[data-file-scheme-sun]").hidden).toBe(false);
    expect(shellCss(element)).toContain(".file-item .glyph[hidden] { display: none; }");
    // The tokens, on the wrap and on each panel host (a panel's own :host defaults beat inheritance).
    expect(surfaceVar(wrap(element))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    expect(wrap(element).style.getPropertyValue("--db-color-scheme")).toBe("dark");
    for (const panel of ["datum-builder-toolbar", "datum-builder-properties", "datum-builder-canvas"]) {
      const host = shell(element).querySelector<HTMLElement>(panel);
      expect(host, panel).not.toBeNull();
      expect(surfaceVar(host!), panel).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    }
    // Remembered for the origin.
    expect(store().getItem(SCHEME_MEMORY_KEY)).toBe("dark");

    // Off again: the vars go, the memory says light.
    q(element, "[data-file-menu]").click();
    item.click();
    await until(() => element.builder!.scheme === "light");
    expect(surfaceVar(wrap(element))).toBe("");
    expect(item.querySelector(".file-item-label")?.textContent).toBe("Dark mode");
    expect(element.getAttribute("scheme")).toBe("light");
    expect(heard).toEqual(["dark", "light"]);
    expect(store().getItem(SCHEME_MEMORY_KEY)).toBe("light");
  });

  it("reads the remembered choice back on connect, unless the page set scheme itself", async () => {
    store().setItem(SCHEME_MEMORY_KEY, "dark");
    const remembered = await mount();
    expect(remembered.builder!.scheme).toBe("dark");
    expect(surfaceVar(wrap(remembered))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    document.body.innerHTML = "";

    const decided = await mount((el) => el.setAttribute("scheme", "light"));
    expect(decided.builder!.scheme).toBe("light");
    expect(surfaceVar(wrap(decided))).toBe("");
    document.body.innerHTML = "";

    store().removeItem(SCHEME_MEMORY_KEY);
    const asked = await mount((el) => el.setAttribute("scheme", "dark"));
    expect(asked.builder!.scheme).toBe("dark");
    expect(surfaceVar(wrap(asked))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    // The property is the attribute; the inner builder follows the wrapper.
    asked.scheme = "light";
    await until(() => asked.builder!.scheme === "light");
    expect(surfaceVar(wrap(asked))).toBe("");
  });

  it("wins over a host theme while dark, and gives the host theme back in light", async () => {
    const element = await mount((el) => {
      el.theme = { id: "host-look", version: "1.0.0", target: "builder", tokens: { "db-accent": "#3d8fe6" } };
    });
    await until(() => wrap(element).style.getPropertyValue("--db-accent") === "#3d8fe6");
    element.scheme = "dark";
    await until(() => wrap(element).style.getPropertyValue("--db-accent") === STUDIO_DARK_TOKENS["db-accent"]);
    expect(surfaceVar(wrap(element))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    element.scheme = "light";
    await until(() => wrap(element).style.getPropertyValue("--db-accent") === "#3d8fe6");
    expect(surfaceVar(wrap(element))).toBe("");
  });

  it("takes the switch off both menus under no-scheme-toggle, and keeps the ⋮ only for file items", async () => {
    const element = await mount((el) => {
      el.setAttribute("no-scheme-toggle", "");
      el.setAttribute("file-actions", "off");
    });
    expect(q(element, "[data-file-scheme]").hidden).toBe(true);
    expect(q(element, "[data-file-actions]").hidden).toBe(true);
    // scheme still sets the look.
    element.scheme = "dark";
    await until(() => surfaceVar(wrap(element)) === STUDIO_DARK_TOKENS["db-surface"]);
    // The phone drawer's Tools section has no Dark mode row either.
    const inner = element.builder as DatumBuilderElement;
    (inner as unknown as { renderMenu(): void }).renderMenu();
    expect(shell(element).querySelector('[data-menu-go="scheme"]')).toBeNull();
  });

  it("offers Dark mode as a row in the phone drawer, which then offers Light mode", async () => {
    const element = await mount();
    const inner = element.builder as DatumBuilderElement;
    (inner as unknown as { renderMenu(): void }).renderMenu();
    const row = shell(element).querySelector<HTMLElement>('[data-menu-go="scheme"]');
    expect(row).not.toBeNull();
    expect(row!.hasAttribute("role")).toBe(false);
    expect(row!.querySelector(".menu-row-label")?.textContent).toBe("Dark mode");
    (inner as unknown as { onMenuGo(row: HTMLElement): void }).onMenuGo(row!);
    await until(() => inner.scheme === "dark");
    (inner as unknown as { renderMenu(): void }).renderMenu();
    expect(shell(element).querySelector<HTMLElement>('[data-menu-go="scheme"] .menu-row-label')!.textContent).toBe("Light mode");
  });

  it("reaches the lazy surfaces and the palette: themed while dark whether made before or after the switch", async () => {
    const element = await mount();
    await modesReady(element);
    const inner = element.builder!;
    const dark = STUDIO_DARK_TOKENS["db-surface"];
    const host = (tag: string): HTMLElement | null => shell(element).querySelector<HTMLElement>(tag);
    // Logic made while light: the switch reaches it (applyTheme's targets).
    inner.setWorkspace("logic");
    await until(() => host("datum-builder-logic"));
    expect(surfaceVar(host("datum-builder-logic")!)).toBe("");
    element.scheme = "dark";
    await until(() => surfaceVar(wrap(element)) === dark);
    expect(surfaceVar(host("datum-builder-logic")!)).toBe(dark);
    // The rest made while dark: painted where they are created.
    for (const [workspace, tag] of [["data", "datum-builder-data"], ["languages", "datum-builder-languages"], ["journeys", "datum-builder-overview"]] as const) {
      inner.setWorkspace(workspace);
      await until(() => host(tag), 8000);
      expect(surfaceVar(host(tag)!), tag).toBe(dark);
    }
    await element.openPalette();
    await until(() => host("datum-builder-palette"));
    expect(surfaceVar(host("datum-builder-palette")!)).toBe(dark);
    // Back to light: every one of them gives the vars up.
    element.scheme = "light";
    await until(() => surfaceVar(wrap(element)) === "");
    for (const tag of ["datum-builder-logic", "datum-builder-data", "datum-builder-languages", "datum-builder-overview", "datum-builder-palette"]) {
      expect(surfaceVar(host(tag)!), tag).toBe("");
    }
  });

  it("lays dark over the host theme: the host's type survives, its colours give way", async () => {
    const element = await mount((el) => {
      el.theme = { id: "host-look", version: "1.0.0", target: "builder", tokens: { "db-font": "Fancy, serif", "db-accent": "#3d8fe6" } };
    });
    await until(() => wrap(element).style.getPropertyValue("--db-font") === "Fancy, serif");
    element.scheme = "dark";
    await until(() => surfaceVar(wrap(element)) === STUDIO_DARK_TOKENS["db-surface"]);
    expect(wrap(element).style.getPropertyValue("--db-font")).toBe("Fancy, serif");
    expect(wrap(element).style.getPropertyValue("--db-accent")).toBe(STUDIO_DARK_TOKENS["db-accent"]);
    const toolbar = shell(element).querySelector<HTMLElement>("datum-builder-toolbar")!;
    expect(toolbar.style.getPropertyValue("--db-font")).toBe("Fancy, serif");
  });

  it("shows a remembered dark scheme on the wrapper without an event, and on its own host's tokens", async () => {
    store().setItem(SCHEME_MEMORY_KEY, "dark");
    const heard: string[] = [];
    const element = await mount((el) => el.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme)));
    expect(element.getAttribute("scheme")).toBe("dark");
    expect(element.builder!.scheme).toBe("dark");
    expect(heard).toEqual([]);
    // The wrapper's own shadow root (status card, Download notice) reads these from its host.
    expect(element.style.getPropertyValue("--db-surface")).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    expect(element.style.getPropertyValue("color-scheme")).toBe("dark");
    // One event per toggle, and the wrapper's host gives the look up in light.
    q(element, "[data-file-menu]").click();
    q(element, "[data-file-scheme]").click();
    await until(() => element.builder!.scheme === "light");
    expect(heard).toEqual(["light"]);
    expect(element.getAttribute("scheme")).toBe("light");
    expect(element.style.getPropertyValue("--db-surface")).toBe("");
    expect(element.style.getPropertyValue("color-scheme")).toBe("");
  });

  it("hands the choice back to the memory when the page removes scheme", async () => {
    store().setItem(SCHEME_MEMORY_KEY, "dark");
    const heard: string[] = [];
    const element = await mount((el) => {
      el.setAttribute("scheme", "light");
      el.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme));
    });
    expect(element.builder!.scheme).toBe("light");
    element.removeAttribute("scheme");
    await until(() => element.builder!.scheme === "dark");
    // Not snapped back to an attribute: the page handed the choice over.
    expect(element.hasAttribute("scheme")).toBe(false);
    expect(heard).toEqual(["dark"]);
    expect(surfaceVar(wrap(element))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    document.body.innerHTML = "";

    // Light remembered: the removal leaves a dark page choice for light, and says so once.
    store().setItem(SCHEME_MEMORY_KEY, "light");
    heard.length = 0;
    const light = await mount((el) => {
      el.setAttribute("scheme", "dark");
      el.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme));
    });
    light.removeAttribute("scheme");
    await until(() => light.builder!.scheme === "light");
    expect(light.hasAttribute("scheme")).toBe(false);
    expect(heard).toEqual(["light"]);
    expect(surfaceVar(wrap(light))).toBe("");
  });

  it("treats the datum-dark host theme as the dark scheme: the switch offers Light mode and works", async () => {
    const element = await mount((el) => el.setAttribute("theme", "datum-dark"));
    const inner = element.builder!;
    await until(() => inner.theme?.id === "datum-dark");
    expect(inner.scheme).toBe("dark");
    expect(element.scheme).toBe("dark");
    const item = q(element, "[data-file-scheme]");
    expect(item.querySelector(".file-item-label")?.textContent).toBe("Light mode");
    expect(surfaceVar(wrap(element))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    q(element, "[data-file-menu]").click();
    item.click();
    await until(() => inner.scheme === "light");
    // Its light half is the built-in look.
    expect(surfaceVar(wrap(element))).toBe("");
    expect(item.querySelector(".file-item-label")?.textContent).toBe("Dark mode");
    q(element, "[data-file-menu]").click();
    item.click();
    await until(() => inner.scheme === "dark");
    expect(surfaceVar(wrap(element))).toBe(STUDIO_DARK_TOKENS["db-surface"]);
  });

  it("lets a remembered scheme beat a datum-dark host theme when the page sets no scheme", async () => {
    store().setItem(SCHEME_MEMORY_KEY, "light");
    const element = await mount((el) => el.setAttribute("theme", "datum-dark"));
    const inner = element.builder!;
    await until(() => inner.theme?.id === "datum-dark");
    // The host theme is only the default: the person's remembered light wins, with the built-in light look.
    expect(inner.scheme).toBe("light");
    expect(surfaceVar(wrap(element))).toBe("");
    expect(q(element, "[data-file-scheme]").querySelector(".file-item-label")?.textContent).toBe("Dark mode");
    expect(q(element, "[data-file-scheme-moon]").hidden).toBe(false);
  });

  it("puts focus back on the drawer's opener after the Dark mode and Full window rows", async () => {
    const element = await mount();
    // The drawer and its opener are the phone tier's (display none at any other width), and jsdom
    // since 30 applies the shell's shadow stylesheet: a button that is not drawn takes no focus.
    // So the shell is told it is 390px wide, as a phone's layout would.
    q(element, "[data-shell=wrap]").getBoundingClientRect = () => ({ width: 390, height: 844, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    await until(() => element.builder!.phoneLayout);
    const inner = element.builder as DatumBuilderElement;
    const opener = shell(element).querySelector<HTMLElement>("[data-menu-open]");
    expect(opener).not.toBeNull();
    for (const go of ["scheme", "full-window"]) {
      (inner as unknown as { renderMenu(): void }).renderMenu();
      const row = shell(element).querySelector<HTMLElement>(`[data-menu-go="${go}"]`)!;
      row.focus();
      (inner as unknown as { onMenuGo(row: HTMLElement): void }).onMenuGo(row);
      expect(shell(element).activeElement, go).toBe(opener);
    }
    expect(inner.scheme).toBe("dark");
    expect(inner.fullWindow).toBe(true);
    inner.fullWindow = false;
  });

  it("reads the remembered scheme once, at connect: a later write from outside changes nothing until the next toggle", async () => {
    const heard: string[] = [];
    const element = await mount((el) => el.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme)));
    await modesReady(element);
    expect(element.builder!.scheme).toBe("light");
    // Another tab (or anything else) writes the store after this builder connected.
    store().setItem(SCHEME_MEMORY_KEY, "dark");
    expect(element.builder!.scheme).toBe("light");
    // A surface made now paints light too, like the rest of the shell.
    element.builder!.setWorkspace("logic");
    await until(() => shell(element).querySelector("datum-builder-logic"));
    expect(surfaceVar(shell(element).querySelector<HTMLElement>("datum-builder-logic")!)).toBe("");
    expect(surfaceVar(wrap(element))).toBe("");
    // The toggle goes from what is on screen: to dark, once.
    q(element, "[data-file-menu]").click();
    q(element, "[data-file-scheme]").click();
    await until(() => element.builder!.scheme === "dark");
    expect(heard).toEqual(["dark"]);
    expect(surfaceVar(shell(element).querySelector<HTMLElement>("datum-builder-logic")!)).toBe(STUDIO_DARK_TOKENS["db-surface"]);
  });

  it("shows a datum-dark host theme as scheme dark on the wrapper, like the remembered dark, with no event", async () => {
    const heard: string[] = [];
    const element = await mount((el) => {
      el.setAttribute("theme", "datum-dark");
      el.addEventListener("datum-builder-scheme-change", (event) => heard.push((event as CustomEvent<{ scheme: string }>).detail.scheme));
    });
    await until(() => element.getAttribute("scheme") === "dark");
    expect(element.builder!.scheme).toBe("dark");
    expect(heard).toEqual([]);
    expect(element.style.getPropertyValue("--db-surface")).toBe(STUDIO_DARK_TOKENS["db-surface"]);
    // A page that chose a scheme keeps its attribute.
    document.body.innerHTML = "";
    const chosen = await mount((el) => {
      el.setAttribute("scheme", "light");
      el.setAttribute("theme", "datum-dark");
    });
    await until(() => chosen.builder!.theme?.id === "datum-dark");
    expect(chosen.getAttribute("scheme")).toBe("light");
  });

  it("draws the form on the canvas in the dark colour scheme while dark, and leaves the binding pick alone", async () => {
    const element = await mount();
    const canvas = shell(element).querySelector<HTMLElement>("datum-builder-canvas")!;
    const preview = (): (HTMLElement & { colorScheme?: string; drawnBinding?: { id: string } }) | null => canvas.shadowRoot!.querySelector("[data-preview]");
    await until(() => preview()?.colorScheme === "light");
    const picks: string[] = [];
    element.addEventListener("datum-builder-binding-change", (event) => picks.push((event as CustomEvent<{ bindingId: string }>).detail.bindingId));

    element.scheme = "dark";
    await until(() => preview()?.colorScheme === "dark");
    // The author's pick is still Datum's; the scheme is the canvas's alone.
    expect(preview()!.drawnBinding?.id).toBe("datum");
    expect(element.builder!.controller.bindingId()).toBe("datum");
    expect(picks).toEqual([]);

    element.scheme = "light";
    await until(() => preview()?.colorScheme === "light");
  });

  it("draws a dark canvas from the first paint when the page mounts the builder dark", async () => {
    const element = await mount((el) => el.setAttribute("scheme", "dark"));
    const canvas = shell(element).querySelector<HTMLElement>("datum-builder-canvas")!;
    await until(() => (canvas.shadowRoot?.querySelector("[data-preview]") as (HTMLElement & { colorScheme?: string }) | null)?.colorScheme === "dark");
  });

  it("gives back what the page set inline on the wrapper when the dark look leaves", async () => {
    const element = await mount((el) => el.setAttribute("style", "--db-ink: red"));
    expect(element.style.getPropertyValue("--db-ink")).toBe("red");
    element.scheme = "dark";
    await until(() => element.builder!.scheme === "dark");
    expect(element.style.getPropertyValue("--db-ink")).toBe(STUDIO_DARK_TOKENS["db-ink"]);
    expect(element.style.getPropertyValue("color-scheme")).toBe("dark");
    element.scheme = "light";
    await until(() => element.builder!.scheme === "light");
    expect(element.style.getPropertyValue("--db-ink")).toBe("red");
    expect(element.style.getPropertyValue("color-scheme")).toBe("");
    expect(element.style.getPropertyValue("--db-surface")).toBe("");
  });
});
