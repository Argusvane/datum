import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumErrorDetail, DatumFormChangeDetail, DatumFormElement } from "../src/form.js";

import { sampleDefinition, until } from "./helpers.js";
import { box, control, describedBy, leave, pick, selectOf, type } from "./live-dom.js";

const COUNTRIES = [
  { value: "CA", label: "Canada" },
  { value: "US", label: "United States" }
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mount(setup?: (element: DatumFormElement) => void): DatumFormElement {
  const element = document.createElement("datum-form");
  setup?.(element);
  document.body.append(element);
  return element;
}

/** The rendered form's shadow root, once the renderer has painted a `<form>`. */
async function paintedForm(element: DatumFormElement): Promise<ShadowRoot> {
  await until(() => element.renderer?.shadowRoot?.querySelector("form"));
  return element.renderer!.shadowRoot!;
}

function nameInput(form: ShadowRoot): HTMLInputElement {
  return control(form, "fullName");
}

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// datum-change reports a typed value once it has settled, not on every keystroke.
describe("<datum-form> datum-change timing", () => {
  it("reports a burst of keystrokes once, with the last value, after typing pauses", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");

    type(nameInput(form), "A");
    type(nameInput(form), "Ad");
    type(nameInput(form), "Ada");
    expect(changes).toEqual([]);

    await until(() => changes.length > 0);
    await settle(400);
    expect(changes.length).toBe(1);
    expect(changes[0]!.path).toBe("fullName");
    expect(changes[0]!.value).toBe("Ada");
    expect(changes[0]!.values.fullName).toBe("Ada");
  });

  it("reports every keystroke with change-debounce 0", async () => {
    const element = mount((el) => {
      el.setAttribute("change-debounce", "0");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(element.changeDebounce).toBe(0);
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");

    type(nameInput(form), "A");
    type(nameInput(form), "Ad");
    expect(changes.map((change) => change.value)).toEqual(["A", "Ad"]);
  });

  it("reports a typed value as soon as the field is left", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");

    type(nameInput(form), "Ada");
    await until(() => element.values.fullName === "Ada");
    leave(nameInput(form));
    expect(changes.length).toBe(1);
    expect(changes[0]!.value).toBe("Ada");

    // The debounce that was running does not report it a second time.
    await settle(400);
    expect(changes.length).toBe(1);
  });

  it("keeps a typed value per field: two fields typed in report as two changes", async () => {
    const element = mount((el) => {
      el.setAttribute("change-debounce", "50");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");

    // Subscribe reveals the conditional email field; that pick is final and reports at once.
    const subscribe = control(form, "subscribe");
    subscribe.checked = true;
    pick(subscribe);
    expect(changes.map((change) => change.path)).toEqual(["subscribe"]);
    await until(() => box(form, "email"));

    type(nameInput(form), "Ada");
    type(control(form, "email"), "ada@example.com");
    await until(() => changes.length === 3);
    expect(changes.slice(1).map((change) => [change.path, change.value])).toEqual([
      ["fullName", "Ada"],
      ["email", "ada@example.com"]
    ]);
    expect(changes[2]!.values).toMatchObject({ fullName: "Ada", email: "ada@example.com", subscribe: true });
  });

  it("under change-on=commit holds a typed value until the field is left, and reports a pick at once", async () => {
    const element = mount((el) => {
      el.setAttribute("change-on", "commit");
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => box(form, "country").querySelectorAll('option[value="CA"]').length === 1);
    expect(element.changeOn).toBe("commit");
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");

    type(nameInput(form), "Ada");
    await until(() => element.values.fullName === "Ada");
    await settle(400);
    expect(changes).toEqual([]);

    const country = selectOf(form, "country");
    country.value = "CA";
    pick(country);
    expect(changes.map((change) => [change.path, change.value])).toEqual([["country", "CA"]]);

    await until(() => selectOf(form, "country").value === "CA");
    leave(nameInput(form));
    expect(changes.map((change) => [change.path, change.value])).toEqual([
      ["country", "CA"],
      ["fullName", "Ada"]
    ]);
  });

  it("reports what is still pending before datum-submit", async () => {
    const element = mount((el) => {
      el.setAttribute("change-on", "commit");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const order: string[] = [];
    element.addEventListener("datum-change", (event) => order.push(`change:${(event as CustomEvent<DatumFormChangeDetail>).detail.value}`));
    element.addEventListener("datum-submit", () => order.push("submit"));

    type(nameInput(form), "Ada Lovelace");
    const result = await element.submit();
    expect(result.accepted).toBe(true);
    expect(order).toEqual(["change:Ada Lovelace", "submit"]);
  });

  it("does not report a prefilled value, and reports a value the page writes at once", async () => {
    const element = mount((el) => {
      el.values = { fullName: "Grace Hopper" };
      el.definition = sampleDefinition();
    });
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");
    const form = await paintedForm(element);
    await until(() => nameInput(form).value === "Grace Hopper");
    expect(changes).toEqual([]);

    element.runtime!.setValue("fullName", "Ada Lovelace");
    expect(changes.map((change) => change.value)).toEqual(["Ada Lovelace"]);
  });

  it("rejects a change-on or change-debounce it cannot use as datum-error, keeping the setting it had", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await paintedForm(element);
    const errors = listen<DatumErrorDetail>(element, "datum-error");

    element.setAttribute("change-on", "never");
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("change-on must be one of input, commit");
    expect(element.changeOn).toBe("input");

    element.setAttribute("change-debounce", "soon");
    expect(errors.length).toBe(2);
    expect(errors[1]!.message).toContain("change-debounce must be a whole number");
    expect(element.changeDebounce).toBe(300);

    element.setAttribute("change-debounce", "-1");
    expect(errors.length).toBe(3);
    consoleError.mockRestore();
  });
});

// The character count is redrawn with the value; its live region speaks once typing pauses.
describe("<datum-form> character count", () => {
  it("redraws the visible count on each keystroke and reads it out once, a second after the last", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content![0]!.configuration = { label: "Full name", required: true, maxLength: 6, characterCount: true };
    const element = mount((el) => {
      el.definition = definition;
    });
    const form = await paintedForm(element);
    const shown = () => box(form, "fullName").textContent!;
    const live = () => form.querySelector<HTMLElement>("[data-count-announcer]")!.textContent!.trim();
    expect(nameInput(form).getAttribute("maxlength")).toBeNull();
    expect(describedBy(nameInput(form))).toContain("You can enter up to 6 characters");
    expect(shown()).toContain("6 characters left");
    expect(live()).toBe("");

    // The count is spoken for the field the person is typing in.
    nameInput(form).focus();
    type(nameInput(form), "Ad");
    await until(() => shown().includes("4 characters left"));
    // Not yet spoken: the person is still typing.
    expect(live()).toBe("");
    type(nameInput(form), "Ada Lovelace");
    await until(() => shown().includes("6 characters over limit"));
    expect(box(form, "fullName").hasAttribute("data-over-limit")).toBe(true);
    expect(live()).toBe("");
    // A second's pause: the same words reach the live region, once.
    await until(() => live() === "6 characters over limit", 2500);
    await settle(300);
    expect(live()).toBe("6 characters over limit");
    // Trimmed back under the limit: the count follows, the state hook goes, the box is not cut short.
    type(nameInput(form), "Ada");
    await until(() => shown().includes("3 characters left"));
    expect(box(form, "fullName").hasAttribute("data-over-limit")).toBe(false);
    expect(nameInput(form).value).toBe("Ada");
  });
});
