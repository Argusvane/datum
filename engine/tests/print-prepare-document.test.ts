// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { datumPrintTheme, type PrintTheme } from "../form-engine/render/print/index.js";
import { PRINT_FRAME_ATTR } from "../form-engine/render/web-component/print-frame.js";
import { DATUM_FORM_RENDERER_TAG, defineDatumFormRendererElement, type DatumFormRendererElement, type DatumPrintDetail } from "../form-engine/render/web-component/form-renderer-element.js";
import { DATUM_FORM_HOST_TAG, defineDatumFormHostElement, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";

/**
 * The print's two halves on `<datum-form-renderer>`: `preparePrintDocument` builds what `print()`
 * would present and touches nothing of the live form; `print()` presents it. `printRenditions`
 * reads what the form offers, and `<datum-form-host>`'s Print button follows it: a plain button
 * for one rendition, a menu of the offered ones for more.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const translations = {
  fr: {
    form: { title: { text: "Demande", source: sourceHash("Intake") } },
    components: { name: { label: { text: "Nom", source: sourceHash("Name") } } }
  }
} as unknown as FormTranslations;

function definition(print?: Record<string, unknown>): FormDefinition {
  const children: ComponentNode[] = [{ id: "name", type: "text", configuration: { label: "Name" } }];
  return {
    id: "intake",
    version: "1",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
    translations,
    root: { id: "root", type: "form", configuration: { title: "Intake", ...(print ? { print } : {}) }, children: { content: children } }
  } as unknown as FormDefinition;
}

function runtimeOf(form: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

const frames = (): HTMLIFrameElement[] => [...document.querySelectorAll<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`)];
const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

async function mounted(form: FormDefinition, setup?: (element: DatumFormRendererElement) => void): Promise<{ element: DatumFormRendererElement; runtime: FormRuntime }> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  const runtime = runtimeOf(form);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return { element, runtime };
}

describe("<datum-form-renderer>.preparePrintDocument()", () => {
  it("builds the document print() would present, and fires no event, opens no frame and moves no focus", async () => {
    const { element, runtime } = await mounted(definition());
    runtime.setValue("name", "Ada");
    const input = element.shadowRoot!.querySelector<HTMLInputElement>('[data-component-id="name"] input')!;
    input.focus();
    const events: string[] = [];
    for (const type of ["datum-print", "datum-change", "datum-locale-applied", "focusin", "focusout"]) {
      element.addEventListener(type, () => events.push(type));
      document.addEventListener(type, () => events.push(`document:${type}`));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prepared = await element.preparePrintDocument();
    expect(prepared).toBeDefined();
    expect(prepared!.theme).toBe("basic");
    expect(prepared!.fellBack).toBeUndefined();
    expect(prepared!.model.rendition).toBe("answers");
    expect(prepared!.model.title).toBe("Intake");
    expect(parse(prepared!.html).querySelector('[data-component-id="name"] .dp-answer')?.textContent).toBe("Ada");
    expect(events).toEqual([]);
    expect(frames()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(element.shadowRoot!.activeElement).toBe(input);
    expect(runtime.state().locale).toBe("en");
  });

  it("prints what print() prints for the same options", async () => {
    const { element, runtime } = await mounted(definition(), (el) => {
      el.printTheme = datumPrintTheme;
    });
    runtime.setValue("name", "Ada");
    const prepared = await element.preparePrintDocument({ rendition: "filled", page: { size: "A4" } });
    let printed: DatumPrintDetail | undefined;
    element.addEventListener("datum-print", (event) => {
      event.preventDefault();
      printed = (event as CustomEvent<DatumPrintDetail>).detail;
    });
    await element.print({ rendition: "filled", page: { size: "A4" } });
    expect(printed?.html).toBe(prepared!.html);
    expect(prepared!.theme).toBe("datum");
    expect(prepared!.model.rendition).toBe("filled");
    expect(prepared!.model.page.size).toBe("A4");
  });

  it("says why a theme was set aside, with the basic theme's model", async () => {
    const refusing: PrintTheme = { id: "ds", label: "DS", css: "", renditions: ["answers"], draw: {} };
    const { element } = await mounted(definition(), (el) => {
      el.printTheme = refusing;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prepared = await element.preparePrintDocument({ rendition: "blank" });
    expect(prepared).toMatchObject({ theme: "basic" });
    expect(prepared!.fellBack?.[0]).toContain('does not draw the "blank" rendition');
    expect(prepared!.model.rendition).toBe("blank");
    expect(warn).not.toHaveBeenCalled();
  });

  it("follows the form's default rendition, and an explicit one wins", async () => {
    const { element } = await mounted(definition({ renditions: ["blank", "answers"] }));
    expect((await element.preparePrintDocument())!.model.rendition).toBe("blank");
    expect((await element.preparePrintDocument({ rendition: "filled" }))!.model.rendition).toBe("filled");
  });

  it("is undefined with no runtime, and refused when print is left out of the features", async () => {
    defineDatumFormRendererElement();
    const bare = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    document.body.append(bare);
    expect(await bare.preparePrintDocument()).toBeUndefined();
    const { element } = await mounted(definition(), (el) => el.setAttribute("features", "minimal"));
    await expect(element.preparePrintDocument()).rejects.toThrow(/preparePrintDocument\(\) is not available/);
  });
});

describe("printing in another locale", () => {
  it("prints in the locale asked for, the live form left in its own", async () => {
    const { element, runtime } = await mounted(definition());
    const french = await element.preparePrintDocument({ locale: "fr" });
    expect(french!.model.locale).toBe("fr");
    expect(french!.model.title).toBe("Demande");
    expect(parse(french!.html).documentElement.getAttribute("lang")).toBe("fr");
    expect(french!.html).toContain("Nom");
    expect(runtime.state().locale).toBe("en");
    expect(element.shadowRoot!.querySelector('[data-component-id="name"] label')?.textContent).toContain("Name");

    let printed: DatumPrintDetail | undefined;
    element.addEventListener("datum-print", (event) => {
      event.preventDefault();
      printed = (event as CustomEvent<DatumPrintDetail>).detail;
    });
    await element.print({ locale: "fr" });
    expect(parse(printed!.html).documentElement.getAttribute("lang")).toBe("fr");
    expect(runtime.state().locale).toBe("en");
    // A blank locale is no locale: the form's own.
    expect((await element.preparePrintDocument({ locale: "  " }))!.model.locale).toBe("en");
  });
});

describe("printRenditions", () => {
  it("reads what the form offers and its default; the defaults with no runtime", async () => {
    defineDatumFormRendererElement();
    const bare = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    expect(bare.printRenditions).toEqual({ offered: ["answers"], default: "answers" });
    const { element } = await mounted(definition({ renditions: ["answers", "blank", "bogus", "blank"], defaultRendition: "blank" }));
    expect(element.printRenditions).toEqual({ offered: ["answers", "blank"], default: "blank" });
    // A copy: changing it changes nothing.
    element.printRenditions.offered.push("filled");
    expect(element.printRenditions.offered).toEqual(["answers", "blank"]);
  });
});

describe("<datum-form-host>'s Print button", () => {
  function host(print?: Record<string, unknown>): { host: DatumFormHostElement; renderer: DatumFormRendererElement; root: ShadowRoot; printed: Array<Parameters<DatumFormRendererElement["print"]>[0]> } {
    defineDatumFormHostElement();
    const element = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    element.runtime = runtimeOf(definition(print));
    document.body.append(element);
    const root = element.shadowRoot!;
    const renderer = root.querySelector("datum-form-renderer") as DatumFormRendererElement;
    const printed: Array<Parameters<DatumFormRendererElement["print"]>[0]> = [];
    vi.spyOn(renderer, "print").mockImplementation(async (options) => {
      printed.push(options);
    });
    return { host: element, renderer, root, printed };
  }
  const key = (target: Element, name: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it("stays a plain button that prints at once when the form offers one rendition", () => {
    const { root, printed } = host();
    const button = root.querySelector<HTMLButtonElement>("[data-print]")!;
    expect(button.hasAttribute("aria-haspopup")).toBe(false);
    expect(button.hasAttribute("aria-expanded")).toBe(false);
    expect(root.querySelectorAll("[data-print-rendition]")).toHaveLength(0);
    button.click();
    expect(printed).toEqual([undefined]);
    expect(root.querySelector<HTMLElement>("[data-print-menu]")!.hidden).toBe(true);
  });

  it("opens a menu of the offered renditions, in the form's order, and prints the one chosen", () => {
    const { root, printed } = host({ renditions: ["blank", "answers"] });
    const button = root.querySelector<HTMLButtonElement>("[data-print]")!;
    const menu = root.querySelector<HTMLElement>("[data-print-menu]")!;
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("part")).toBe("print-menu");
    const options = [...menu.querySelectorAll<HTMLButtonElement>("[data-print-rendition]")];
    expect(options.map((option) => [option.dataset.printRendition, option.textContent, option.getAttribute("role"), option.getAttribute("part")])).toEqual([
      ["blank", "Blank form", "menuitem", "print-option"],
      ["answers", "Answers", "menuitem", "print-option"]
    ]);
    button.click();
    expect(printed).toEqual([]);
    expect(menu.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(root.activeElement).toBe(options[0]);
    options[1]!.click();
    expect(printed).toEqual([{ rendition: "answers" }]);
    expect(menu.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(button);
  });

  it("works from the keyboard: arrows open and move, Home and End jump, Escape closes onto the button, Tab leaves", () => {
    const { root, printed } = host({ renditions: ["answers", "blank", "filled"] });
    const button = root.querySelector<HTMLButtonElement>("[data-print]")!;
    const menu = root.querySelector<HTMLElement>("[data-print-menu]")!;
    const options = [...menu.querySelectorAll<HTMLButtonElement>("[data-print-rendition]")];
    expect(options.map((option) => option.tabIndex)).toEqual([-1, -1, -1]);
    button.focus();
    expect(key(button, "ArrowDown").defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(false);
    expect(root.activeElement).toBe(options[0]);
    key(options[0]!, "ArrowDown");
    expect(root.activeElement).toBe(options[1]);
    key(options[1]!, "End");
    expect(root.activeElement).toBe(options[2]);
    key(options[2]!, "ArrowDown");
    expect(root.activeElement).toBe(options[0]);
    key(options[0]!, "ArrowUp");
    expect(root.activeElement).toBe(options[2]);
    key(options[2]!, "Home");
    expect(root.activeElement).toBe(options[0]);
    key(options[0]!, "Escape");
    expect(menu.hidden).toBe(true);
    expect(root.activeElement).toBe(button);
    key(button, "ArrowUp");
    expect(root.activeElement).toBe(options[2]);
    // Enter on a menu item is its click.
    options[2]!.click();
    expect(printed).toEqual([{ rendition: "filled" }]);
    key(button, "ArrowDown");
    key(options[0]!, "Tab");
    expect(menu.hidden).toBe(true);
  });

  it("closes when the person presses outside it, and follows a new runtime's renditions", () => {
    const { host: element, root } = host({ renditions: ["answers", "blank"] });
    const button = root.querySelector<HTMLButtonElement>("[data-print]")!;
    const menu = root.querySelector<HTMLElement>("[data-print-menu]")!;
    button.click();
    expect(menu.hidden).toBe(false);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(menu.hidden).toBe(true);

    element.runtime = runtimeOf(definition());
    expect(button.hasAttribute("aria-haspopup")).toBe(false);
    expect(menu.children).toHaveLength(0);
    element.runtime = runtimeOf(definition({ renditions: ["filled", "blank"] }));
    expect([...menu.querySelectorAll<HTMLElement>("[data-print-rendition]")].map((option) => option.dataset.printRendition)).toEqual(["filled", "blank"]);
  });

  it("words the menu through the form texts, in the form's locale", () => {
    defineDatumFormHostElement();
    const element = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    element.texts = {
      printLabel: { default: "Print", locales: { fr: "Imprimer" } },
      printAnswers: { default: "Answers", locales: { fr: "Réponses" } },
      printBlank: { default: "Blank form", locales: { fr: "Formulaire vierge" } }
    };
    const runtime = runtimeOf(definition({ renditions: ["answers", "blank"] }));
    element.runtime = runtime;
    document.body.append(element);
    const root = element.shadowRoot!;
    runtime.setLocale("fr");
    expect(root.querySelector("[data-print-menu]")!.getAttribute("aria-label")).toBe("Imprimer");
    expect([...root.querySelectorAll("[data-print-rendition]")].map((option) => option.textContent)).toEqual(["Réponses", "Formulaire vierge"]);
  });

  it("is hidden, menu and all, when print is left out of the features", () => {
    const { host: element, root } = host({ renditions: ["answers", "blank"] });
    element.features = "minimal";
    expect(root.querySelector<HTMLButtonElement>("[data-print]")!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("[data-print-wrap]")!.hidden).toBe(true);
    expect(root.querySelectorAll("[data-print-rendition]")).toHaveLength(0);
  });
});
