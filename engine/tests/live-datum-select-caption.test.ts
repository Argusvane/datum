// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { LanguageSwitcherState, LiveBinding } from "../form-engine/render/live/contract.js";
import { chromeFeature } from "../form-engine/render/live/chrome.js";
import { createFieldsFeature } from "../form-engine/render/live/fields.js";
import { render } from "../form-engine/render/live/lit.js";
import { datumChoiceComponents } from "../form-engine/render/live/datum/choice-fields.js";
import { datumLanguageSwitcher } from "../form-engine/render/live/datum/chrome.js";
import { cleanUp, definitionOf, mounted, quiet, settled, wrapper } from "./live-extras-kit.js";
import { mountDatum } from "./live-datum-kit.js";

/*
 * A select shows its caption whenever none of its options is the answer, so the browser never
 * shows the first option as if it were chosen (choosing it would then fire no change): Datum's
 * select, the date's month select and the language switchers. An optional select's caption is
 * choosable, so its answer can be cleared.
 */

afterEach(cleanUp);

const binding: LiveBinding = { id: "datum", label: "Datum", components: { ...datumChoiceComponents() } };
const select = (extra: Record<string, unknown> = {}): ComponentNode => ({
  id: "pick",
  type: "select",
  configuration: { label: "Contact by", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }], ...extra }
});

async function drawSelect(configuration: Record<string, unknown>, value?: unknown): Promise<HTMLSelectElement> {
  quiet();
  const m = await mounted(definitionOf([select(configuration)]), { binding, features: [createFieldsFeature()] });
  if (value !== undefined) {
    m.runtime.setValue("pick", value);
    await settled(m.form);
  }
  return wrapper(m.root, "pick").querySelector("select") as HTMLSelectElement;
}

describe("select: the caption stands for no answer", () => {
  it("shows the caption, not the first option, for a value none of the options carries", async () => {
    const control = await drawSelect({ required: true }, "fax");
    expect(control.selectedIndex).toBe(0);
    expect(control.options[0]?.value).toBe("");
    expect(Array.from(control.options).slice(1).some((option) => option.selected)).toBe(false);
  });

  it("goes back to the caption when the answer changes to a value none of the options carries", async () => {
    quiet();
    const m = await mounted(definitionOf([select({ required: true })]), { binding, features: [createFieldsFeature()] });
    m.runtime.setValue("pick", "phone");
    await settled(m.form);
    const control = wrapper(m.root, "pick").querySelector("select") as HTMLSelectElement;
    expect(control.value).toBe("phone");
    m.runtime.setValue("pick", "fax");
    await settled(m.form);
    expect(control.selectedIndex).toBe(0);
  });

  it("lists an optional select's caption enabled, so choosing it clears the answer", async () => {
    quiet();
    const m = await mounted(definitionOf([select()]), { binding, features: [createFieldsFeature()] });
    m.runtime.setValue("pick", "phone");
    await settled(m.form);
    const control = wrapper(m.root, "pick").querySelector("select") as HTMLSelectElement;
    const caption = control.options[0] as HTMLOptionElement;
    expect(caption.disabled).toBe(false);
    expect(caption.hidden).toBe(false);
    control.value = "";
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await settled(m.form);
    expect(m.runtime.state().values["pick"]).toBe("");
  });

  it("keeps a required select's caption disabled and out of the list", async () => {
    const control = await drawSelect({ required: true });
    expect(control.options[0]?.disabled).toBe(true);
    expect(control.options[0]?.hidden).toBe(true);
  });
});

describe("date: the month select's caption", () => {
  it("shows the caption for a stored month outside 01 to 12", async () => {
    quiet();
    const definition = definitionOf([{ id: "born", type: "date", configuration: { label: "Date of birth" } }] as never);
    const m = await mountDatum(definition, { date: { month: "select" } });
    m.runtime.setValue("born", "2024-13-05");
    await settled(m.form);
    const month = m.root.querySelector('select[data-value-part="month"]') as HTMLSelectElement;
    expect(month.selectedIndex).toBe(0);
    expect(month.value).toBe("");
  });
});

describe("language switcher: a current locale none of the options is", () => {
  const state = (current: string): LanguageSwitcherState =>
    ({
      current,
      locales: [
        { code: "fr", label: "Français" },
        { code: "de", label: "Deutsch" }
      ],
      label: "Language",
      hideLabel: false,
      controlId: "lang",
      switchTo: () => true
    }) as unknown as LanguageSwitcherState;

  it("shows a blank rather than the first language, so choosing it still switches", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(datumLanguageSwitcher(state("en")), host);
    const control = host.querySelector("select") as HTMLSelectElement;
    expect(control.value).toBe("");
    expect(Array.from(control.options).find((option) => option.value === "fr")?.selected).toBe(false);
    render(datumLanguageSwitcher(state("en")), host);
    expect(control.value).toBe("");
    host.remove();
  });

  it("draws no blank when the current locale is listed", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(datumLanguageSwitcher(state("de")), host);
    const control = host.querySelector("select") as HTMLSelectElement;
    expect(control.value).toBe("de");
    expect(Array.from(control.options).map((option) => option.value)).toEqual(["fr", "de"]);
    host.remove();
  });

  it("does the same in the engine's own switcher", async () => {
    quiet();
    const definition = definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "fr", label: "Français" }, { code: "de", label: "Deutsch" }] }
    } as never);
    (definition.root.configuration as Record<string, unknown>).chrome = { header: [{ id: "lang", type: "language-switcher" }] };
    const m = await mounted(definition, { features: [chromeFeature()] });
    const control = m.root.querySelector("select[data-locale-switch]") as HTMLSelectElement | null;
    expect(control).not.toBeNull();
    expect(m.runtime.state().locale).toBe("en");
    expect(control?.value).toBe("");
  });
});
