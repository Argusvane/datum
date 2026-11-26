// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { RegisteredClientDataSourceRuntime } from "../form-engine/data/client/registered-client-data-source-runtime.js";
import { DataSourceProviderRegistry } from "../form-engine/data/providers/data-source-provider-registry.js";
import { StaticDataSourceProvider } from "../form-engine/data/providers/static-data-source-provider.js";
import { DataSourceRegistry } from "../form-engine/registry/data-sources/data-source-registry.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";

/*
 * What the element keeps across the repaint a write brings back: the box a person is typing in
 * (and the caret in it), the textarea, the part of a date being typed, the checkbox or radio just
 * chosen (options fed by a data source), and the language switcher just used. A radio pick is a
 * final write, so leaving it commits nothing more.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 300): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function definitionOf(content: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: "repaint",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration: {}, children: { content } },
    ...extra
  } as FormDefinition;
}

function methodsSource(): RegisteredClientDataSourceRuntime {
  const providers = new DataSourceProviderRegistry();
  providers.register(
    new StaticDataSourceProvider("static-methods", [
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone" },
      { value: "mail", label: "Mail" }
    ])
  );
  const sources = new DataSourceRegistry();
  sources.register({ id: "methods", providerId: "static-methods", version: "1.0.0" });
  return new RegisteredClientDataSourceRuntime(sources, providers);
}

function runtimeOf(form: FormDefinition, dataSources?: RegisteredClientDataSourceRuntime): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([]),
    ...(dataSources ? { dataSources } : {})
  });
}

async function mounted(runtime: FormRuntime, setup?: (element: DatumFormRendererElement) => void): Promise<{ element: DatumFormRendererElement; root: ShadowRoot }> {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return { element, root: element.shadowRoot! };
}

const box = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-component-id="${id}"]`)!;
const control = <E extends HTMLElement = HTMLInputElement>(root: ShadowRoot, id: string, selector = "input, select, textarea"): E => box(root, id).querySelector<E>(selector)!;

/** A keystroke: sets the box's text and fires the input event the browser would. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

type Seen = Array<{ type: string; data: unknown }>;
const record = (runtime: FormRuntime): Seen => {
  const seen: Seen = [];
  runtime.events().subscribe("*", (event) => seen.push({ type: event.type, data: event.data }));
  return seen;
};
const dataOf = (seen: Seen, type: string): unknown[] => seen.filter((event) => event.type === type).map((event) => event.data);

describe("the box being typed in", () => {
  it("keeps the caret where it was, in the same box, when the write repaints the field", async () => {
    const runtime = runtimeOf(definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }]));
    const { root } = await mounted(runtime);
    const input = control(root, "name");
    input.focus();
    input.value = "Adab";
    // The caret sits between "Ad" and "ab": what a person editing the middle of a word has.
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => runtime.state().values.name === "Adab");
    await wait(30);

    const after = control(root, "name");
    expect(after).toBe(input);
    expect(root.activeElement).toBe(after);
    expect(after.value).toBe("Adab");
    expect(after.selectionStart).toBe(2);
    expect(after.selectionEnd).toBe(2);
  });

  it("keeps a textarea, its text and its focus", async () => {
    const runtime = runtimeOf(definitionOf([{ id: "notes", type: "textarea", configuration: { label: "Notes" } }]));
    const { root } = await mounted(runtime);
    const area = control<HTMLTextAreaElement>(root, "notes", "textarea");
    expect(area).toBeTruthy();
    area.focus();
    typeInto(area, "Allergic to peanuts");
    await until(() => runtime.state().values.notes === "Allergic to peanuts");
    await wait(30);

    const repainted = control<HTMLTextAreaElement>(root, "notes", "textarea");
    expect(repainted).toBe(area);
    expect(repainted.value).toBe("Allergic to peanuts");
    expect(root.activeElement).toBe(repainted);
  });
});

describe("a date being typed", () => {
  const dateForm = () => definitionOf([{ id: "dob", type: "date", configuration: { label: "Date of birth" } }]);
  const part = (root: ShadowRoot, name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-value-part="${name}"]`)!;

  it("keeps focus in the part being typed once the parts make a date, and stores nothing before they do", async () => {
    const runtime = runtimeOf(dateForm());
    const { root } = await mounted(runtime);

    // An incomplete group writes nothing: no repaint fights the person mid-date.
    typeInto(part(root, "day"), "15");
    typeInto(part(root, "month"), "07");
    expect(runtime.state().values.dob).toBeUndefined();

    part(root, "year").focus();
    typeInto(part(root, "year"), "2001");
    await until(() => runtime.state().values.dob === "2001-07-15");
    await wait(30);

    // The completing repaint kept the part being typed in, not the group's start.
    const year = part(root, "year");
    expect(year.value).toBe("2001");
    expect(root.activeElement).toBe(year);
  });

  it("stores an empty answer, not a stale one, when a part is cleared again", async () => {
    const runtime = runtimeOf(dateForm());
    const { root } = await mounted(runtime);
    typeInto(part(root, "day"), "15");
    typeInto(part(root, "month"), "07");
    typeInto(part(root, "year"), "2001");
    await until(() => runtime.state().values.dob === "2001-07-15");

    typeInto(part(root, "day"), "");
    await until(() => runtime.state().values.dob === "");
  });
});

describe("options fed by a data source", () => {
  const prefsForm = () => definitionOf([{ id: "prefs", type: "checkboxes", configuration: { label: "How may we contact you?", data: { sourceId: "methods" } } }]);
  const contactForm = () => definitionOf([{ id: "contact", type: "radio", configuration: { label: "Preferred contact", data: { sourceId: "methods" } } }]);
  const choice = (root: ShadowRoot, id: string, type: "checkbox" | "radio", value: string): HTMLInputElement =>
    box(root, id).querySelector<HTMLInputElement>(`input[type="${type}"][value="${value}"]`)!;

  it("composes a checkboxes group into one object of booleans and keeps focus on the toggled box", async () => {
    const runtime = runtimeOf(prefsForm(), methodsSource());
    const { root } = await mounted(runtime);
    await until(() => box(root, "prefs").querySelectorAll('input[type="checkbox"]').length === 3);
    // Nothing is written before the first interaction.
    expect(runtime.state().values.prefs).toBeUndefined();

    choice(root, "prefs", "checkbox", "email").focus();
    choice(root, "prefs", "checkbox", "email").click();
    await until(() => JSON.stringify(runtime.state().values.prefs) === JSON.stringify({ email: true, phone: false, mail: false }));
    await wait(30);
    // The commit repaints: focus stays on the toggled box, which stays checked.
    expect(root.activeElement).toBe(choice(root, "prefs", "checkbox", "email"));
    expect(choice(root, "prefs", "checkbox", "email").checked).toBe(true);

    choice(root, "prefs", "checkbox", "phone").click();
    await until(() => (runtime.state().values.prefs as Record<string, boolean>).phone === true);
    expect(runtime.state().values.prefs).toEqual({ email: true, phone: true, mail: false });

    // Unticking flips the key to false rather than removing it.
    choice(root, "prefs", "checkbox", "email").click();
    await until(() => (runtime.state().values.prefs as Record<string, boolean>).email === false);
    expect(runtime.state().values.prefs).toEqual({ email: false, phone: true, mail: false });
  });

  it("writes the picked radio option and lands focus on that option, not the group's first", async () => {
    const runtime = runtimeOf(contactForm(), methodsSource());
    const { root } = await mounted(runtime);
    await until(() => box(root, "contact").querySelectorAll('input[type="radio"]').length === 3);

    const phone = choice(root, "contact", "radio", "phone");
    phone.focus();
    phone.click();
    await until(() => runtime.state().values.contact === "phone");
    await wait(30);

    const repainted = choice(root, "contact", "radio", "phone");
    expect(repainted.checked).toBe(true);
    expect(root.activeElement).toBe(repainted);
  });

  it("writes a radio pick as final, not interim, so leaving the group commits nothing more", async () => {
    const runtime = runtimeOf(contactForm(), methodsSource());
    const { root } = await mounted(runtime);
    await until(() => box(root, "contact").querySelectorAll('input[type="radio"]').length === 3);
    const seen = record(runtime);

    const phone = choice(root, "contact", "radio", "phone");
    phone.focus();
    phone.click();
    await until(() => runtime.state().values.contact === "phone");

    expect(dataOf(seen, "COMPONENT_CHANGED")).toEqual([{ value: "phone" }]);
    // Nothing was interim, so there is nothing for leaving the group to commit.
    choice(root, "contact", "radio", "phone").dispatchEvent(new FocusEvent("blur"));
    choice(root, "contact", "radio", "phone").dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
    expect(dataOf(seen, "COMPONENT_COMMITTED")).toEqual([]);
  });
});

describe("the language switcher", () => {
  it("keeps focus on the switcher across the repaint its pick brings", async () => {
    const form = definitionOf([{ id: "fullName", type: "text", configuration: { label: "Full name" } }], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr-CA" }] },
      translations: { "fr-CA": { components: { fullName: { label: { text: "Nom complet", source: sourceHash("Full name") } } } } }
    } as Partial<FormDefinition>);
    const runtime = runtimeOf(form);
    const { element, root } = await mounted(runtime, (el) => {
      el.chrome = { header: [{ type: "language-switcher" }] };
    });
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
    expect(select).toBeTruthy();
    const applied: string[] = [];
    element.addEventListener("datum-locale-applied", (event) => applied.push((event as CustomEvent<{ locale: string }>).detail.locale));

    select.focus();
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(runtime.state().locale).toBe("fr-CA");
    expect(applied).toEqual(["fr-CA"]);
    await until(() => box(root, "fullName").textContent?.includes("Nom complet"));
    await wait(30);
    // The form repainted in French; the switcher shows the new locale and still has focus: the
    // person who just used it has not lost their place.
    const repainted = root.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
    expect(repainted.value).toBe("fr-CA");
    expect(root.activeElement).toBe(repainted);
  });
});
