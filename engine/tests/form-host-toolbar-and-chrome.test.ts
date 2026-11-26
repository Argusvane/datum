// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { ICON_FALLBACK_CLASS, markupIconSet } from "../form-engine/render/icons/icon-set.js";
import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";
import type { DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";

/**
 * What `<datum-form-host>` draws around the form: the actions row (Validate, Print, the page's
 * slotted actions), its icons, and the chrome it hands the renderer, including the
 * `languageSwitcher` shorthand and the locale events that cross the host's boundary.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function runtimeOf(): FormRuntime {
  const form = {
    id: "f1",
    version: "1",
    schemaVersion: "1",
    // The form names its own locales: these labels are what every switcher shows.
    localization: {
      defaultLocale: "en",
      supportedLocales: [
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français (Canada)" }
      ]
    },
    translations: { "fr-CA": { components: { fullName: { label: { text: "Nom complet", source: sourceHash("Full name") } } } } },
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } } as ComponentNode] }
    }
  } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

function mountHost(runtime: FormRuntime = runtimeOf()): DatumFormHostElement {
  defineDatumFormHostElement();
  const el = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
  document.body.append(el);
  el.languageSwitcher = true;
  el.runtime = runtime;
  return el;
}

const rendererOf = (el: HTMLElement): DatumFormRendererElement => el.shadowRoot!.querySelector("datum-form-renderer") as DatumFormRendererElement;
/** The renderer's shadow root: where the form, and its chrome, draws. */
const rendererShadowOf = (el: HTMLElement): ShadowRoot => rendererOf(el).shadowRoot!;

/** The chrome's switcher, once the renderer has drawn it. */
async function localeSelectOf(el: HTMLElement): Promise<HTMLSelectElement> {
  const shadow = rendererShadowOf(el);
  await vi.waitFor(() => {
    expect(shadow.querySelector("select[data-locale-switch]")).toBeTruthy();
  });
  return shadow.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
}

describe("the host's actions row", () => {
  it("composes the renderer and draws no switcher of its own", () => {
    const el = mountHost();
    expect(rendererOf(el)).toBeTruthy();
    // The language switcher is form chrome the renderer draws, not a host control.
    expect(el.shadowRoot!.querySelector("datum-locale-select")).toBeNull();
  });

  it("holds Validate and Print and no locale select, with the page's slotted action beside them", () => {
    const el = mountHost();
    const button = document.createElement("button");
    button.slot = "actions";
    button.textContent = "Restore draft";
    el.append(button);

    const row = el.shadowRoot!.querySelector(".host-actions-row")!;
    const slot = row.querySelector<HTMLSlotElement>('slot[name="actions"]')!;
    expect(slot.assignedElements()).toContain(button);
    expect(row.querySelector("[data-validate]")).toBeTruthy();
    expect(row.querySelector("[data-print]")).toBeTruthy();
    expect(row.querySelector("[data-locale-switch]")).toBeNull();
    expect(row.querySelector("datum-locale-select")).toBeNull();
    // The rendered form carries no actions block of its own: the host's row is the only one.
    expect(rendererShadowOf(el).querySelectorAll("[data-validate], [data-print]")).toHaveLength(0);
  });

  it("puts Print after Validate, as part print, and a click on its glyph still prints", () => {
    const el = mountHost();
    const row = el.shadowRoot!.querySelector(".host-actions-row")!;
    const print = row.querySelector<HTMLButtonElement>("[data-print]")!;
    expect(print.getAttribute("part")).toBe("print");
    const validate = row.querySelector("[data-validate]")!;
    expect(validate.compareDocumentPosition(print) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const spy = vi.spyOn(rendererOf(el), "print").mockResolvedValue(undefined);
    print.click();
    expect(spy).toHaveBeenCalledTimes(1);
    // The click usually lands on the glyph inside the button; it must still reach print().
    print.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("draws Validate and Print as an icon beside a label, named independently of the label", () => {
    // A host can hide the label parts for an icon-only toolbar, so the button's name has to
    // survive without them: aria-label and title carry it.
    const el = mountHost();
    const row = el.shadowRoot!.querySelector(".host-actions-row")!;
    for (const [name, part] of [
      ["Validate", "validate"],
      ["Print", "print"]
    ] as const) {
      const button = row.querySelector<HTMLButtonElement>(`[data-${part}]`)!;
      expect(button.getAttribute("aria-label")).toBe(name);
      expect(button.title).toBe(name);
      expect(button.querySelector("svg[aria-hidden='true']")).toBeTruthy();
      expect(button.querySelector(`[part="${part}-label"]`)!.textContent).toBe(name);
    }
  });
});

describe("the host's icons", () => {
  it("draws the buttons from the icon set it is given, falling back per name, and resets", () => {
    const el = mountHost();
    const row = el.shadowRoot!.querySelector(".host-actions-row")!;
    // No icon set: the engine's own drawings, marked as the fallback they are.
    expect(row.querySelector(`[data-validate] svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();

    el.icons = markupIconSet("acme", { validate: () => '<i class="acme" data-acme="validate"></i>' }, ".acme { color: red; }");
    expect(row.querySelector('[data-validate] i[data-acme="validate"]')).toBeTruthy();
    expect(row.querySelector(`[data-print] svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect(el.shadowRoot!.querySelector("style[data-icon-css]")!.textContent).toBe(".acme { color: red; }");

    // The glyph is still not the hit target: a click on it reaches the button's action.
    const spy = vi.spyOn(rendererOf(el), "validate").mockResolvedValue(undefined as never);
    row.querySelector("[data-validate] i")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(spy).toHaveBeenCalledTimes(1);

    el.icons = undefined;
    expect(row.querySelector(`[data-validate] svg.${ICON_FALLBACK_CLASS}`)).toBeTruthy();
    expect(el.shadowRoot!.querySelector("style[data-icon-css]")!.textContent).toBe("");
  });
});

describe("the host's language switcher", () => {
  it("turns languageSwitcher into a header switcher over the form's own labelled locales", async () => {
    const el = mountHost();
    const select = await localeSelectOf(el);
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ["en", "English"],
      ["fr-CA", "Français (Canada)"]
    ]);
    expect(select.value).toBe("en");
    // Chrome sits inside the form's root element, ahead of the fields.
    const form = select.closest("form")!;
    expect(form).toBeTruthy();
    expect(form.firstElementChild?.contains(select)).toBe(true);
  });

  it("applies a pick to the runtime, re-draws the translated label, and reports it to a listener on the host", async () => {
    const runtime = runtimeOf();
    const el = mountHost(runtime);
    const applied: string[] = [];
    // Dispatched by the renderer, composed, so it reaches a listener on the host element.
    el.addEventListener("datum-locale-applied", (event) => {
      applied.push((event as CustomEvent<{ locale: string }>).detail.locale);
    });

    const select = await localeSelectOf(el);
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(runtime.state().locale).toBe("fr-CA");
    expect(applied).toEqual(["fr-CA"]);
    await vi.waitFor(() => {
      expect(rendererShadowOf(el).querySelector("[data-component-id]")?.textContent).toContain("Nom complet");
    });
    expect((await localeSelectOf(el)).value).toBe("fr-CA");
  });

  it("puts the switcher back and reports datum-locale-rejected to the host for a locale the runtime refuses", async () => {
    const runtime = runtimeOf();
    const el = mountHost(runtime);
    const rejections: Array<{ locale: string; message: string }> = [];
    el.addEventListener("datum-locale-rejected", (event) => {
      rejections.push((event as CustomEvent<{ locale: string; message: string }>).detail);
    });

    const select = await localeSelectOf(el);
    // "de-DE" is not in the form's supportedLocales; wiring it onto the select proves the
    // runtime-side rejection path.
    const rogue = document.createElement("option");
    rogue.value = "de-DE";
    select.appendChild(rogue);
    select.value = "de-DE";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(rejections).toHaveLength(1);
    });
    expect(rejections[0]?.locale).toBe("de-DE");
    expect(rejections[0]?.message).toMatch(/not supported/);
    expect(runtime.state().locale).toBe("en");
    expect(select.value).toBe("en");
  });

  it("lets an explicit chrome choose the footer over the languageSwitcher shorthand", async () => {
    const el = mountHost();
    el.chrome = { footer: [{ type: "language-switcher", hideLabel: true }] } as never;
    const shadow = rendererShadowOf(el);
    const select = await localeSelectOf(el);
    // After the fields, not before them: the footer, not the header.
    expect(shadow.querySelector("form")!.firstElementChild?.contains(select)).toBe(false);
    expect(shadow.querySelector("[data-component-id]")!.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Exactly one switcher: the shorthand does not draw a second one in the header.
    expect(shadow.querySelectorAll("select[data-locale-switch]")).toHaveLength(1);
  });
});
