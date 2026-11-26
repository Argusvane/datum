import { sourceHash, type Expression, type FormDefinition, type Journey } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";
import type { DatumFormElement } from "../src/form.js";

/*
 * The element test helpers this package's tests share. Nothing here defines the element: a test
 * imports `../src/form.js` first, which does.
 */

/** Polls `check` until it returns truthy (or returns without throwing), failing after `timeoutMs`. */
export async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      if (check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw lastError instanceof Error ? lastError : new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A `<datum-form>` set up by `setup` (attributes, the definition) and then attached to the body. */
export function mount(setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  document.body.append(element);
  return element;
}

/** The rendered form's shadow root, once the renderer has painted a `<form>`. */
export async function paintedForm(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return element.renderer!.shadowRoot!;
}

/**
 * A small form exercising what the wrapper elements route: a required text field with a
 * translated label, a select over a data source, a conditional field, and a submit button.
 */
export function sampleDefinition(): FormDefinition {
  return {
    id: "sample-form",
    version: "2.0.0",
    schemaVersion: "1",
    localization: {
      defaultLocale: "en",
      supportedLocales: [
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français (Canada)" }
      ]
    },
    // The French wording of the one translated text, in the form's own map.
    translations: { "fr-CA": { components: { fullName: { label: { text: "Nom complet", source: sourceHash("Full name") } } } } },
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Sample" },
      children: {
        content: [
          {
            id: "fullName",
            type: "text",
            configuration: {
              label: "Full name",
              required: true
            }
          },
          {
            id: "country",
            type: "select",
            configuration: { label: "Country", data: { sourceId: "countries" } }
          },
          {
            id: "subscribe",
            type: "checkbox",
            configuration: { label: "Subscribe" }
          },
          {
            id: "email",
            type: "text",
            configuration: { label: "Email" },
            rules: { visibleWhen: { kind: "path", path: "subscribe" } }
          },
          {
            id: "submit",
            type: "button",
            configuration: { label: "Send", action: "submit" }
          }
        ]
      }
    }
  };
}

/**
 * `definition` with the engine's own words in `locale` added to its `texts` translations (the
 * engine words only English): `texts` by form text key, `messages` by validation code.
 */
export function withEngineWords(
  definition: FormDefinition,
  locale: string,
  words: { texts?: Record<string, string>; messages?: Record<string, string> }
): FormDefinition {
  const entries = (table: Record<string, string> | undefined) => Object.fromEntries(Object.entries(table ?? {}).map(([key, text]) => [key, { text, source: "x" }]));
  const translations = { ...(definition.translations ?? {}) } as Record<string, Record<string, unknown>>;
  translations[locale] = { ...(translations[locale] ?? {}), texts: { form: entries(words.texts), messages: entries(words.messages) } };
  return { ...definition, translations: translations as NonNullable<FormDefinition["translations"]> };
}

/** What `modesReady` reads of a `<datum-form-builder>` (typed loosely, so this file imports no element). */
interface ModesHost {
  pdf?: string | undefined;
  journeys?: string | undefined;
  hiddenWorkspaces: readonly string[];
  pdfMode?: unknown;
  journeyMode?: unknown;
}

/**
 * The PDF and Journeys modes are chunks, registered once their loader resolves:
 * waits until each side that is on and shown has its mode, as a test that drives either at once needs.
 */
export async function modesReady(element: ModesHost, timeoutMs = 4000): Promise<void> {
  await until(
    () =>
      (element.pdf === "off" || element.hiddenWorkspaces.includes("pdf") || element.pdfMode !== undefined) &&
      (element.journeys === "off" || element.hiddenWorkspaces.includes("journeys") || element.journeyMode !== undefined),
    timeoutMs
  );
}

// Journey fixtures shared by the journey tests.
const journeyPath = (name: string): Expression => ({ kind: "path", path: name });
const journeyEq = (name: string, value: string): Expression => ({ kind: "binary", operator: "eq", left: journeyPath(name), right: { kind: "literal", value } });
const YES_NO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

/** A four-page journey: about, residence (resident yes) or overseas (otherwise), contact. */
export function branchingJourneyForm(): FormDefinition {
  const journey: Journey = {
    id: "apply",
    pages: [
      { id: "about", title: "About you", components: ["resident"], routes: [{ when: { kind: "binary", operator: "neq", left: journeyPath("resident"), right: { kind: "literal", value: "yes" } }, to: "overseas" }] },
      { id: "residence", title: "Where you live", components: ["province"], routes: [{ to: "contact" }] },
      { id: "overseas", title: "Where you live abroad", components: ["country"] },
      { id: "contact", title: "How to reach you", components: ["email"], routes: [{ to: "$end" }] }
    ]
  };
  return {
    id: "gj3", version: "1.0.0", schemaVersion: "1",
    root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: [
      { id: "resident", type: "radio", configuration: { label: "Resident?", required: true, options: YES_NO } },
      { id: "province", type: "text", configuration: { label: "Province", required: true } },
      { id: "country", type: "text", configuration: { label: "Country", required: true } },
      { id: "email", type: "text", configuration: { label: "Email", required: true } }
    ] } },
    journey: { journeys: [journey] }
  } as unknown as FormDefinition;
}
export function mountForm(setup?: (el: DatumFormElement) => void): DatumFormElement {
  const el = document.createElement("datum-form") as DatumFormElement;
  setup?.(el);
  document.body.append(el);
  return el;
}
/**
 * A journey page heading's title: its text without the step count drawn over it ("Step 2 of 4"
 * and its hidden colon, Datum's `.datum-form__journey-progress`, on by default).
 */
export function journeyTitleOf(heading: Element | null | undefined): string | undefined {
  if (!heading) {
    return undefined;
  }
  const count = heading.querySelector(".datum-form__journey-progress")?.textContent ?? "";
  const text = heading.textContent ?? "";
  return (text.startsWith(count) ? text.slice(count.length) : text).trim();
}
export const journeyHeading = (el: DatumFormElement) => journeyTitleOf(el.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
export async function onJourneyPage(el: DatumFormElement, title: string): Promise<ShadowRoot> {
  await until(() => journeyHeading(el) === title);
  return el.renderer!.shadowRoot!;
}
export function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}
export function pickRadio(root: ShadowRoot, name: string, value: string): void {
  root.querySelector<HTMLInputElement>(`[data-component-id="${name}"] input[type="radio"][value="${value}"]`)!.click();
}

/** `<datum-form-builder workspaces="pdf">`: the builder as the PDF layouts alone, not yet on the page. */
export function pdfAlone(): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.setAttribute("workspaces", "pdf");
  return element;
}
