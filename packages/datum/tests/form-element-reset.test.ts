/**
 * `reset()` takes a <datum-form> back to how it first opened for its current definition: the
 * typed answers, the errors shown and a journey's place go; the page's `values` seed comes back;
 * the chosen language, the definition and the settings stay. It is the rebuild a newly assigned
 * definition gets, and the page hears of it as one `datum-change`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormChangeDetail, DatumFormElement, DatumFormReadyDetail, DatumFormSubmitDetail } from "../src/form.js";
import type { FormDefinition, Journey } from "@argusvane/datum-engine";

import { journeyTitleOf, paintedForm, sampleDefinition, until } from "./helpers.js";
import { control, invalidIds, type } from "./live-dom.js";

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.restoreAllMocks();
});

function listen<T>(element: HTMLElement, name: string): T[] {
  const seen: T[] = [];
  element.addEventListener(name, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

async function typedForm(setup?: (element: DatumFormElement) => void) {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.definition = sampleDefinition();
  setup?.(element);
  const ready = listen<DatumFormReadyDetail>(element, "datum-ready");
  const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
  const changes = listen<DatumFormChangeDetail>(element, "datum-change");
  document.body.append(element);
  const form = await paintedForm(element);
  await until(() => ready.length === 1);
  type(control(form, "fullName"), "Ada Lovelace");
  await until(() => element.values.fullName === "Ada Lovelace");
  return { element, ready, submits, changes };
}

describe("<datum-form> reset()", () => {
  it("clears the typed answer from the form and from the next datum-submit", async () => {
    const { element, ready, submits } = await typedForm();
    await element.reset();
    expect(ready).toHaveLength(2);
    expect(element.values.fullName).toBeUndefined();
    const form = await paintedForm(element);
    await until(() => control(form, "fullName").value === "");

    // Nothing is left to send for the required field, so the submit is refused and carries no submission.
    await element.submit();
    expect(submits).toHaveLength(1);
    expect(submits[0]!.accepted).toBe(false);
    expect(submits[0]!.submission).toBeUndefined();

    type(control(form, "fullName"), "Grace Hopper");
    await until(() => element.values.fullName === "Grace Hopper");
    await element.submit();
    expect(submits[1]!.accepted).toBe(true);
    expect(JSON.stringify(submits[1]!.submission)).not.toContain("Ada");
  });

  it("puts the page's seed values back", async () => {
    const { element } = await typedForm((el) => {
      el.values = { fullName: "Seeded Name" };
    });
    // Typed over the seed ("Ada Lovelace"), then reset: the seed is what the form opened with.
    expect(element.values.fullName).toBe("Ada Lovelace");
    await element.reset();
    expect(element.values.fullName).toBe("Seeded Name");
    const form = await paintedForm(element);
    await until(() => control(form, "fullName").value === "Seeded Name");
  });

  it("clears the errors a check showed", async () => {
    const { element } = await typedForm();
    type(control(await paintedForm(element), "fullName"), "");
    await element.validate({ focus: false });
    const form = await paintedForm(element);
    await until(() => invalidIds(form).includes("fullName"));
    expect(element.errors.length).toBeGreaterThan(0);

    await element.reset();
    expect(element.errors).toEqual([]);
    const fresh = await paintedForm(element);
    await until(() => invalidIds(fresh).length === 0);
  });

  it("clears errors and a notice the page set", async () => {
    const { element } = await typedForm();
    element.setErrors([{ code: "taken", message: "Taken.", componentId: "fullName" }]);
    element.setNotice({ kind: "info", title: "Received" });
    expect(element.notice).toBeDefined();
    await element.reset();
    expect(element.errors).toEqual([]);
    expect(element.notice).toBeUndefined();
  });

  it("keeps the language the person chose", async () => {
    const { element } = await typedForm();
    element.setLocale("fr-CA");
    expect(element.activeLocale).toBe("fr-CA");
    await element.reset();
    expect(element.activeLocale).toBe("fr-CA");
    expect(element.values.fullName).toBeUndefined();
  });

  it("keeps the definition and the settings", async () => {
    const { element } = await typedForm((el) => {
      el.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
    });
    const definition = element.definition;
    await element.reset();
    expect(element.definition).toBe(definition);
    const form = await paintedForm(element);
    await until(() => control<HTMLSelectElement>(form, "country")?.options.length > 1);
  });

  it("raises one datum-change, with no path and the cleared answers, before it resolves", async () => {
    const { element, changes } = await typedForm();
    // What typing reported is not what this counts.
    await until(() => changes.length >= 1);
    const before = changes.length;
    await element.reset();
    expect(changes).toHaveLength(before + 1);
    const last = changes[changes.length - 1]!;
    expect(last.path).toBeUndefined();
    expect(last.values.fullName).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toHaveLength(before + 1);
  });

  it("leaves a stored draft alone, and a change after it saves the cleared form over it", async () => {
    const { element } = await typedForm((el) => {
      el.draft = "reset-draft";
      el.features = "drafts";
    });
    await element.saveDraft();
    expect(await element.hasDraft()).toBe(true);
    await element.reset();
    // Nothing deleted, nothing written by the reset itself.
    expect(await element.hasDraft()).toBe(true);
    const stored = Object.entries(localStorage).map(([, value]) => value).join("");
    expect(stored).toContain("Ada Lovelace");

    // The next change arms the autosave, which saves the form as it now stands.
    const form = await paintedForm(element);
    type(control(form, "fullName"), "Grace Hopper");
    await until(() => !Object.entries(localStorage).map(([, value]) => value).join("").includes("Ada Lovelace"), 3000);
  });

  it("resolves at once for a form with no definition", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    document.body.append(element);
    await expect(element.reset()).resolves.toBeUndefined();
  });
});

describe("<datum-form> reset() on a journey", () => {
  const journey: Journey = {
    id: "apply",
    name: "Apply",
    validation: { continue: "page" },
    pages: [
      { id: "first", title: "First page", components: ["name"], routes: [{ to: "second" }] },
      { id: "second", title: "Second page", components: ["note"], routes: [{ to: "$end" }] }
    ]
  };
  const definition = (): FormDefinition => ({
    id: "reset-journey",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Journey" },
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "note", type: "text", configuration: { label: "Note" } }
        ]
      }
    },
    journey: { journeys: [journey] }
  });

  it("goes back to the first page with the answers cleared", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    element.definition = definition();
    document.body.append(element);
    const heading = () => journeyTitleOf(element.renderer?.shadowRoot?.querySelector<HTMLElement>("[data-journey-heading]"));
    await until(() => heading() === "First page");
    type(control(element.renderer!.shadowRoot!, "name"), "Ada");
    await until(() => element.values.name === "Ada");
    element.renderer!.shadowRoot!.querySelector<HTMLElement>("[data-journey-continue]")!.click();
    await until(() => heading() === "Second page");

    await element.reset();
    await until(() => heading() === "First page");
    expect(element.page).toBe("first");
    expect(element.values.name).toBeUndefined();
  });
});
