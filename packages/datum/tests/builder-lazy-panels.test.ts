import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Header & footer and Variables panels are chunks of their own: fetched the
 * first time a panel opens (or at connect, for one remembered open), once per page, with the
 * loading card meanwhile and a failure card with Retry. The loaders are wrapped to count the
 * fetches the shell asks for, to hold one until a test lets it go, and to fail one on demand.
 * The wrapper keeps its own "on the page" flag, reset before each test, so no test depends on
 * another's loads (the custom elements, once defined, stay defined for the file).
 */
type Gate = { promise: Promise<void>; open(): void };
const gateOf = (): Gate => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const fetches = vi.hoisted(() => ({
  chrome: 0,
  variables: 0,
  failChrome: 0,
  failVariables: 0,
  chromeOnPage: false,
  variablesOnPage: false,
  holdChrome: undefined as Promise<void> | undefined,
  holdVariables: undefined as Promise<void> | undefined
}));

vi.mock("../../../engine/form-engine/builder/web-component/chrome-panel-loader.js", async (importOriginal) => {
  const actual = await importOriginal<{ loadChromePanel(): Promise<unknown>; chromePanelLoaded(): unknown }>();
  return {
    ...actual,
    chromePanelLoaded: () => (fetches.chromeOnPage ? actual.chromePanelLoaded() : undefined),
    loadChromePanel: async () => {
      fetches.chrome += 1;
      if (fetches.failChrome > 0) {
        fetches.failChrome -= 1;
        throw new Error("offline");
      }
      await fetches.holdChrome;
      const module = await actual.loadChromePanel();
      fetches.chromeOnPage = true;
      return module;
    }
  };
});

vi.mock("../../../engine/form-engine/builder/web-component/variables-panel-loader.js", async (importOriginal) => {
  const actual = await importOriginal<{ loadVariablesPanel(): Promise<unknown>; variablesPanelLoaded(): unknown }>();
  return {
    ...actual,
    variablesPanelLoaded: () => (fetches.variablesOnPage ? actual.variablesPanelLoaded() : undefined),
    loadVariablesPanel: async () => {
      fetches.variables += 1;
      if (fetches.failVariables > 0) {
        fetches.failVariables -= 1;
        throw new Error("offline");
      }
      await fetches.holdVariables;
      const module = await actual.loadVariablesPanel();
      fetches.variablesOnPage = true;
      return module;
    }
  };
});

import "../src/builder.js";
import { clearPanelMemory, writePanelMemory } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

beforeEach(() => {
  Object.assign(fetches, {
    chrome: 0,
    variables: 0,
    failChrome: 0,
    failVariables: 0,
    chromeOnPage: false,
    variablesOnPage: false,
    holdChrome: undefined,
    holdVariables: undefined
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  clearPanelMemory("lazy-t");
  vi.restoreAllMocks();
});

// Whether any test in this file has defined the panel tags yet (they stay defined for the file).
let tagsDefinedBefore = false;

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("features", "-pdf");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const host = (element: DatumFormBuilderElement, tag: string): HTMLElement => shell(element).querySelector<HTMLElement>(tag)!;
const stripItem = (element: DatumFormBuilderElement, panel: string): HTMLButtonElement =>
  shell(element).querySelector<HTMLButtonElement>(`[data-strip] [data-panel="${panel}"]`)!;
const formPanelRoot = (element: DatumFormBuilderElement): ShadowRoot => {
  const form = host(element, "datum-builder-form-panel");
  if (form.hidden) {
    stripItem(element, "form").click();
  }
  return form.shadowRoot!;
};
const deepActive = (): Element | null => {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

describe("the lazy Header & footer and Variables panels", () => {
  it("fetches neither panel while neither is opened: the elements stay bare and undefined", async () => {
    const element = await mount();
    stripItem(element, "outline").click();
    stripItem(element, "components").click();
    element.builder!.setWorkspace("logic");
    element.builder!.setWorkspace("form");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetches).toMatchObject({ chrome: 0, variables: 0 });
    for (const tag of ["datum-builder-chrome-panel", "datum-builder-variables-panel"]) {
      if (!tagsDefinedBefore) {
        expect(customElements.get(tag), tag).toBeUndefined();
        expect(host(element, tag).shadowRoot, tag).toBeNull();
      }
      expect(host(element, tag).hidden, tag).toBe(true);
      expect(host(element, tag).children, tag).toHaveLength(0);
    }
    tagsDefinedBefore = true;
  });

  // Early on purpose, with no load that succeeds: a Retry card is focusable only while its host has no
  // shadow root (before the panel's element is defined). Once any test has loaded the chunk the tag stays
  // defined for the file, the card sits in the light DOM of an upgraded host with no slot to draw it, and
  // jsdom (since 30) rightly takes it out of the flat tree, as a browser does, and refuses it focus.
  it("puts focus on the failure card's Retry when a Retry fails again", async () => {
    fetches.failVariables = 2;
    const element = await mount();
    const panel = host(element, "datum-builder-variables-panel");
    stripItem(element, "variables").click();
    await until(() => panel.querySelector("[data-panel-retry]"));
    panel.querySelector<HTMLButtonElement>("[data-panel-retry]")!.focus();
    panel.querySelector<HTMLButtonElement>("[data-panel-retry]")!.click();
    await until(() => fetches.variables === 2);
    await until(() => shell(element).activeElement === panel.querySelector("[data-panel-retry]"));
  });

  it("shows the failure card with Retry when the Variables chunk does not load, and Retry fetches it", async () => {
    fetches.failVariables = 1;
    const element = await mount();
    const errors: Array<{ message: string; cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
    stripItem(element, "variables").click();
    const panel = host(element, "datum-builder-variables-panel");
    expect(panel.hidden).toBe(false);
    // The loading card at once, in the element's light DOM until the panel draws in its own root.
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("Loading Variables…");
    await until(() => panel.querySelector("[data-panel-retry]"));
    expect(fetches.variables).toBe(1);
    expect(panel.querySelector('[role="alert"]')).toBeTruthy();
    expect(panel.shadowRoot).toBeNull();
    // The host hears of it once, with the cause.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("Variables didn't load. Check the connection and try again.");
    expect((errors[0]!.cause as Error).message).toBe("offline");

    panel.querySelector<HTMLButtonElement>('[data-panel-retry="variables"]')!.click();
    await until(() => panel.shadowRoot?.querySelector(".variables-head"));
    expect(fetches.variables).toBe(2);
    // The cards are gone; the panel lists the form's fields.
    expect(panel.children).toHaveLength(0);
    expect(panel.shadowRoot!.querySelector('[data-variable="fullName"]')).toBeTruthy();

    // Closing and opening again, in this shell or a new one, fetches nothing more.
    stripItem(element, "variables").click();
    stripItem(element, "variables").click();
    expect(panel.shadowRoot!.querySelector(".variables-head")).toBeTruthy();
    document.body.innerHTML = "";
    const again = await mount();
    stripItem(again, "variables").click();
    expect(host(again, "datum-builder-variables-panel").shadowRoot!.querySelector(".variables-head")).toBeTruthy();
    expect(fetches.variables).toBe(2);
  });

  it("opens the Header & footer panel from the Form panel's Footer row once its chunk arrives, focus in the footer", async () => {
    fetches.failChrome = 1;
    const element = await mount();
    const panel = host(element, "datum-builder-chrome-panel");
    // A first try that fails leaves the card; asking again (the row once more) fetches again.
    formPanelRoot(element).querySelector<HTMLButtonElement>('[data-chrome-open="footer"]')!.click();
    expect(element.builder!.panel).toBe("chrome");
    await until(() => panel.querySelector('[data-panel-retry="chrome"]'));
    expect(fetches.chrome).toBe(1);

    formPanelRoot(element).querySelector<HTMLButtonElement>('[data-chrome-open="footer"]')!.click();
    expect(element.builder!.panel).toBe("chrome");
    await until(() => (deepActive() as HTMLElement | null)?.closest?.('[data-chrome-region="footer"]'));
    expect(fetches.chrome).toBe(2);
    // The empty footer's Add picker is its first control, as when the panel was eager.
    expect((deepActive() as HTMLElement).dataset.chromeAddType).toBe("");
  });

  it("fetches a panel remembered open at connect, the loading card then the panel in one paint", async () => {
    const gate = gateOf();
    fetches.holdChrome = gate.promise;
    const chromeModule = await import("../../../engine/form-engine/builder/web-component/builder-chrome-panel.js");
    // The draws, not the requests: a paint asked for while the panel is hidden or suspended draws nothing.
    const base = chromeModule.DatumBuilderChromePanelElement.prototype as unknown as { render(): void };
    const original = base.render;
    let paints = 0;
    base.render = function (this: HTMLElement) {
      paints += 1;
      return original.call(this);
    };
    try {
      writePanelMemory("lazy-t", { panel: "chrome", propsCollapsed: false });
      const element = await mount((el) => el.setAttribute("persist-panels", "lazy-t"));
      expect(element.builder!.panel).toBe("chrome");
      const panel = host(element, "datum-builder-chrome-panel");
      // Asked for at connect, held: the card shows and nothing else has been fetched.
      expect(fetches).toMatchObject({ chrome: 1, variables: 0 });
      expect(panel.hidden).toBe(false);
      expect(panel.querySelector('[role="status"]')).toBeTruthy();
      expect(panel.querySelector('[aria-busy]')).toBeNull();
      const before = paints;
      gate.open();
      await until(() => panel.shadowRoot?.querySelector(".chrome-head"));
      expect(panel.shadowRoot!.querySelector(".chrome-head")?.textContent).toBe("Header & footer");
      expect(panel.children).toHaveLength(0);
      expect(fetches.chrome).toBe(1);
      // Adoption feeds every property under suspendPaints: exactly one paint lands.
      expect(paints - before).toBe(1);
    } finally {
      base.render = original;
    }
  });

  it("wires a panel remembered open from the chunk already on the page, without a fetch", async () => {
    // Put the chunk on the page, then forget the fetch it took.
    const first = await mount();
    stripItem(first, "chrome").click();
    await until(() => host(first, "datum-builder-chrome-panel").shadowRoot?.querySelector(".chrome-head"));
    document.body.innerHTML = "";
    fetches.chrome = 0;

    writePanelMemory("lazy-t", { panel: "chrome", propsCollapsed: false });
    const element = await mount((el) => el.setAttribute("persist-panels", "lazy-t"));
    const panel = host(element, "datum-builder-chrome-panel");
    expect(panel.hidden).toBe(false);
    expect(panel.shadowRoot!.querySelector(".chrome-head")?.textContent).toBe("Header & footer");
    expect(fetches.chrome).toBe(0);
  });

  it("keeps the panel shown last visible when two panels are switched to while one loads, adopting once", async () => {
    const gate = gateOf();
    fetches.holdChrome = gate.promise;
    const element = await mount();
    const panel = host(element, "datum-builder-chrome-panel");
    stripItem(element, "chrome").click();
    stripItem(element, "form").click();
    stripItem(element, "chrome").click();
    stripItem(element, "form").click();
    expect(element.builder!.panel).toBe("form");
    // One load for the four switches.
    expect(fetches.chrome).toBe(1);
    gate.open();
    await until(() => panel.shadowRoot && panel.children.length === 0);
    const root = panel.shadowRoot;
    // The form panel is the one showing; the Header & footer panel was adopted hidden.
    expect(panel.hidden).toBe(true);
    expect(host(element, "datum-builder-form-panel").hidden).toBe(false);
    stripItem(element, "chrome").click();
    expect(panel.hidden).toBe(false);
    expect(panel.shadowRoot!.querySelector(".chrome-head")).toBeTruthy();
    // Not adopted a second time: the same root, no further fetch.
    expect(panel.shadowRoot).toBe(root);
    expect(fetches.chrome).toBe(1);
  });

  it("answers a panel that throws on adoption with the failure card and a datum-error, not a rejection", async () => {
    const chromeModule = await import("../../../engine/form-engine/builder/web-component/builder-chrome-panel.js");
    // The element cannot be defined: the upgrade step throws before the panel exists.
    const define = vi.spyOn(customElements, "upgrade").mockImplementation(() => {
      throw new Error("upgrade broke");
    });
    expect(chromeModule.DatumBuilderChromePanelElement).toBeTruthy();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const element = await mount();
      const errors: Array<{ message: string; cause: unknown }> = [];
      element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string; cause: unknown }>).detail));
      const panel = host(element, "datum-builder-chrome-panel");
      stripItem(element, "chrome").click();
      await until(() => panel.querySelector("[data-panel-retry]"));
      expect(panel.hidden).toBe(false);
      expect(panel.querySelector('[role="alert"]')).toBeTruthy();
      expect(errors).toHaveLength(1);
      expect((errors[0]!.cause as Error).message).toBe("upgrade broke");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);

      // Retry once the upgrade works again: the panel arrives.
      define.mockRestore();
      panel.querySelector<HTMLButtonElement>("[data-panel-retry]")!.click();
      await until(() => panel.shadowRoot?.querySelector(".chrome-head"));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps a panel whose property setter throws on adoption, reports it, and leaves paints balanced", async () => {
    const chromeModule = await import("../../../engine/form-engine/builder/web-component/builder-chrome-panel.js");
    vi.spyOn(chromeModule.DatumBuilderChromePanelElement.prototype, "textLocale", "set").mockImplementation(() => {
      throw new Error("setter broke");
    });
    const element = await mount();
    const errors: Array<{ cause: unknown }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ cause: unknown }>).detail as { cause: unknown }));
    const panel = host(element, "datum-builder-chrome-panel");
    stripItem(element, "chrome").click();
    await until(() => errors.length > 0);
    expect((errors[0]!.cause as Error).message).toBe("setter broke");
    // The finally put the host's visibility back and released the suspension: the next change draws.
    expect(panel.hidden).toBe(false);
    const render = vi.spyOn(chromeModule.DatumBuilderChromePanelElement.prototype as unknown as { render(): void }, "render");
    (panel as unknown as { primary: boolean }).primary = false;
    expect(render).toHaveBeenCalled();
  }, 20000);
});
