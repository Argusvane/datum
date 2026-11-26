/**
 * A setting that rebuilds the runtime for the form already on the page keeps what the person
 * typed: the answers carry into the new runtime, show in the fields and go out with the next
 * `datum-submit`. A definition the page puts in place (a new one, or the same object assigned
 * again) starts afresh, and `values` the page assigns alongside a rebuild win over the carried
 * answers. Settings the renderer takes in place never rebuild at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement, DatumFormReadyDetail, DatumFormSubmitDetail } from "../src/form.js";

import { paintedForm, sampleDefinition, until } from "./helpers.js";
import { control, type } from "./live-dom.js";

const COUNTRIES = [
  { value: "CA", label: "Canada" },
  { value: "US", label: "United States" }
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function listen<T>(element: HTMLElement, name: string): T[] {
  const seen: T[] = [];
  element.addEventListener(name, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

async function typedForm(): Promise<{ element: DatumFormElement; ready: DatumFormReadyDetail[]; submits: DatumFormSubmitDetail[] }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.dataSources = { countries: COUNTRIES };
  element.definition = sampleDefinition();
  const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
  const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
  document.body.append(element);
  const form = await paintedForm(element);
  await until(() => ready.length === 1);
  type(control(form, "fullName"), "Ada Lovelace");
  await until(() => element.values.fullName === "Ada Lovelace");
  return { element, ready, submits };
}

/** Each setting that rebuilds the runtime, set to something new. */
const REBUILDS: Array<[string, (element: DatumFormElement) => void]> = [
  ["dataSources", (element) => (element.dataSources = { countries: [...COUNTRIES] })],
  ["the data-sources attribute", (element) => element.setAttribute("data-sources", JSON.stringify({ countries: COUNTRIES }))],
  ["translations", (element) => (element.translations = { "fr-CA": { components: { fullName: { label: "Nom" } } } } as never)],
  ["draft", (element) => (element.draft = "intake")],
  ["the draft-store attribute", (element) => element.setAttribute("draft-store", "local")],
  ["componentDefinitions", (element) => (element.componentDefinitions = [])],
  ["plugins", (element) => (element.plugins = [])],
  ["features", (element) => (element.features = "-pdf")],
  ["formulaErrors", (element) => (element.formulaErrors = "warn")],
  ["riskyPatterns", (element) => (element.riskyPatterns = "allow")],
  ["signingProviders", (element) => (element.signingProviders = [])],
  ["signing", (element) => (element.signing = { scope: "values" })],
  ["validateTimeout", (element) => (element.validateTimeout = 5000)],
  ["the data-source-timeout attribute", (element) => element.setAttribute("data-source-timeout", "5000")]
];

describe("<datum-form> keeps the typed answers across a rebuild for the same definition", () => {
  for (const [name, change] of REBUILDS) {
    it(`keeps them when ${name} changes, and submits them`, async () => {
      const { element, ready, submits } = await typedForm();
      const before = element.runtime;
      change(element);
      await until(() => ready.length === 2);
      expect(element.runtime).not.toBe(before);
      expect(element.values.fullName).toBe("Ada Lovelace");
      const form = await paintedForm(element);
      await until(() => control(form, "fullName").value === "Ada Lovelace");

      await element.submit();
      expect(submits).toHaveLength(1);
      expect(submits[0]!.accepted).toBe(true);
      expect(submits[0]!.submission).toMatchObject({ submission: { values: { fullName: "Ada Lovelace" } } });
    });
  }

  it("keeps the language the person switched to", async () => {
    const { element, ready } = await typedForm();
    element.setLocale("fr-CA");
    expect(element.activeLocale).toBe("fr-CA");
    element.dataSources = { countries: [...COUNTRIES] };
    await until(() => ready.length === 2);
    expect(element.activeLocale).toBe("fr-CA");
    expect(element.values.fullName).toBe("Ada Lovelace");
  });

  it("puts values assigned with the rebuild over the carried answers, and keeps the carried ones over an earlier seed", async () => {
    const { element, ready } = await typedForm();
    element.values = { fullName: "Grace Hopper" };
    element.dataSources = { countries: [...COUNTRIES] };
    await until(() => ready.length === 2);
    expect(element.values.fullName).toBe("Grace Hopper");

    // The seed stays the same; the person types over it; a later rebuild keeps what they typed.
    const form = await paintedForm(element);
    type(control(form, "fullName"), "Katherine Johnson");
    await until(() => element.values.fullName === "Katherine Johnson");
    element.validateTimeout = 2000;
    await until(() => ready.length === 3);
    expect(element.values.fullName).toBe("Katherine Johnson");
  });
});

describe("<datum-form> settings the renderer takes in place", () => {
  const IN_PLACE: Array<[string, (element: DatumFormElement) => void]> = [
    ["messages", (element) => (element.messages = { required: "Fill this in." })],
    ["texts", (element) => (element.texts = { submitting: "Sending…" })],
    ["locale", (element) => (element.locale = "fr-CA")],
    ["frame", (element) => (element.frame = "paper")],
    ["headingLevel", (element) => (element.headingLevel = 2)],
    ["errorSummaryPlacement", (element) => (element.errorSummaryPlacement = ["bottom"])]
  ];
  for (const [name, change] of IN_PLACE) {
    it(`keeps the runtime and its answers when ${name} changes`, async () => {
      const { element, ready } = await typedForm();
      const before = element.runtime;
      change(element);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ready).toHaveLength(1);
      expect(element.runtime).toBe(before);
      expect(element.values.fullName).toBe("Ada Lovelace");
    });
  }
});

describe("<datum-form> starts afresh for a definition the page puts in place", () => {
  it("drops the typed answers for a new definition", async () => {
    const { element, ready } = await typedForm();
    element.definition = sampleDefinition();
    await until(() => ready.length === 2);
    expect(element.values.fullName).toBeUndefined();
  });

  it("drops them when the same definition object is assigned again, and when it comes with another setting", async () => {
    const { element, ready } = await typedForm();
    element.definition = element.definition;
    await until(() => ready.length === 2);
    expect(element.values.fullName).toBeUndefined();

    const form = await paintedForm(element);
    type(control(form, "fullName"), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    element.dataSources = { countries: [...COUNTRIES] };
    element.definition = element.definition;
    await until(() => ready.length === 3);
    expect(element.values.fullName).toBeUndefined();
  });

  it("seeds a new definition with values, never with the old form's answers", async () => {
    const { element, ready } = await typedForm();
    element.values = { country: "CA" };
    element.definition = sampleDefinition();
    await until(() => ready.length === 2);
    expect(element.values.fullName).toBeUndefined();
    expect(element.values.country).toBe("CA");
  });
});
