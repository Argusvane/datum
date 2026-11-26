// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { capabilityAnswers, fieldCapabilitiesOf, type LiveBinding, type NumberFieldState, type TextFieldState } from "../form-engine/render/live/contract.js";
import { createFieldsFeature } from "../form-engine/render/live/fields.js";
import { datumChoiceComponents } from "../form-engine/render/live/datum/choice-fields.js";
import type { DatumFieldOptionsInput } from "../form-engine/render/live/datum/field-scaffold.js";
import { datumTextComponents } from "../form-engine/render/live/datum/text-fields.js";
import { createTooltipsFeature } from "../form-engine/render/live/tooltips.js";
import { createReadonlySizingFeature } from "../form-engine/render/live/readonly-sizing.js";
import type { LiveFeature } from "../form-engine/render/live/mount.js";
import type { LiveMode } from "../form-engine/render/live/contract.js";
import { cleanUp, definitionOf, mounted, quiet, settled, wrapper, type Mounted } from "./live-extras-kit.js";

/*
 * Datum's text-like and choice adapters (render/live/datum/text-fields.ts, choice-fields.ts) and
 * the per-kind state they are handed (render/live/fields.ts), mounted through mountLive with the
 * Datum binding: each fixture's tree is asserted by the roles, names, `for`, `aria-*`, classes and
 * the live properties of its controls.
 */

afterEach(cleanUp);

// ── Mounting ───────────────────────────────────────────────────────────────────────────────

function datumBinding(options?: DatumFieldOptionsInput): LiveBinding {
  return { id: "datum", label: "Datum", components: { ...datumTextComponents(options), ...datumChoiceComponents(options) } };
}

interface Drawn extends Mounted {
  /** The field's shell: the element the adapter drew inside the renderer's wrapper. */
  shell(id: string): HTMLElement;
}

async function draw(children: ComponentNode[], options: DatumFieldOptionsInput & { mode?: LiveMode; values?: Record<string, unknown>; features?: LiveFeature[] } = {}): Promise<Drawn> {
  quiet();
  const m = await mounted(definitionOf(children), {
    binding: datumBinding(options),
    features: [createFieldsFeature(), createTooltipsFeature(), ...(options.features ?? [])],
    ...(options.mode !== undefined ? { mode: options.mode } : {})
  });
  for (const [path, value] of Object.entries(options.values ?? {})) {
    m.runtime.setValue(path, value);
  }
  if (options.values !== undefined) {
    await settled(m.form);
  }
  return {
    ...m,
    shell: (id) => wrapper(m.root, id).firstElementChild as HTMLElement
  };
}

const text = (extra: Record<string, unknown> = {}, id = "name"): ComponentNode => ({ id, type: "text", configuration: { label: "Full name", ...extra } });
const choices = (type: "radio" | "select" | "checkboxes", extra: Record<string, unknown> = {}, id = "pick"): ComponentNode => ({
  id,
  type,
  configuration: {
    label: "Contact by",
    options: [
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone", description: "Weekdays only" },
      { value: "post", label: "Post" }
    ],
    ...extra
  }
});

const inputOf = (drawn: Drawn, id: string): HTMLInputElement => drawn.shell(id).querySelector("input") as HTMLInputElement;

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

// ── The tree ───────────────────────────────────────────────────────────────────────────────

describe("datum text fields: the tree", () => {
  it("draws a plain text box", async () => {
    const drawn = await draw([text()]);
    const box = inputOf(drawn, "name");
    expect(box.getAttribute("aria-labelledby")).toBe("name__label");
    expect(box.closest("label")?.getAttribute("for")).toBe("name");
  });

  it("draws required, described, hinted, placeholder and pattern text boxes", async () => {
    const drawn = await draw([
      text({ required: true, description: "As on your passport", placeholder: "Jane Doe", minLength: 2, pattern: "[A-Za-z ]+", autocomplete: "name", inputmode: "text", spellcheck: false })
    ]);
    const box = inputOf(drawn, "name");
    expect(box.getAttribute("aria-required")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe("name__description");
    expect(box.getAttribute("placeholder")).toBe("Jane Doe");
    expect(box.getAttribute("minlength")).toBe("2");
    expect(box.getAttribute("spellcheck")).toBe("false");
    // The limit is the check's: never `maxlength`.
    expect(box.hasAttribute("maxlength")).toBe(false);
  });

  it("leaves out a pattern the browser could not compile", async () => {
    const drawn = await draw([text({ pattern: "(" })]);
    expect(inputOf(drawn, "name").hasAttribute("pattern")).toBe(false);
  });

  it("draws prefix and suffix as decorative affixes around the box", async () => {
    const drawn = await draw([text({ prefix: "$", suffix: "CAD" }, "price")]);
    const group = drawn.shell("price").querySelector(".datum-form__control-group");
    expect(Array.from(group?.children ?? []).map((child) => child.className)).toEqual(["datum-form__affix datum-form__affix--prefix", "datum-form__control datum-form__control--text datum-form__control--box", "datum-form__affix datum-form__affix--suffix"]);
    expect(group?.querySelector(".datum-form__affix")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws a hidden label as visually hidden, still the control's name", async () => {
    const drawn = await draw([text({ hideLabel: true })]);
    expect(drawn.shell("name").querySelector("#name__label")?.classList.contains("datum-form__visually-hidden")).toBe(true);
  });

  it("draws the help mark in the label and describes the control by its bubble", async () => {
    const drawn = await draw([text({ description: "Hint", tooltip: "Your legal name" })]);
    const box = inputOf(drawn, "name");
    expect(box.getAttribute("aria-describedby")).toBe("name__description name__tooltip");
    const mark = drawn.shell("name").querySelector("[data-tooltip-mark]");
    expect(mark?.getAttribute("role")).toBe("button");
    expect(mark?.getAttribute("aria-label")).toBe("Help");
    expect(drawn.shell("name").querySelector("#name__tooltip")?.textContent).toBe("Your legal name");
    // The mark sits outside the named span, so the control's name is the words alone.
    expect(drawn.shell("name").querySelector("#name__label")?.textContent).toBe("Full name");
  });

  it("draws an inline error as an alert the control is described by and flagged invalid", async () => {
    const drawn = await draw([text({ required: true, description: "Hint" })]);
    await drawn.runtime.validate();
    await settled(drawn.form);
    const box = inputOf(drawn, "name");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe("name__description name__error");
    const error = drawn.shell("name").querySelector("#name__error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe("This field is required");
    expect(wrapper(drawn.root, "name").hasAttribute("data-invalid")).toBe(true);
  });

  it("draws the count under a counted box and describes the control by the limit sentence", async () => {
    const drawn = await draw([text({ maxLength: 10, characterCount: true, description: "Short" })]);
    expect(inputOf(drawn, "name").getAttribute("aria-describedby")).toBe("name__description name__count");
    expect(drawn.shell("name").querySelector("#name__count")?.textContent).toBe("You can enter up to 10 characters");
    expect(drawn.shell("name").querySelector(".datum-form__count-status")?.textContent).toBe("10 characters left");
    type(inputOf(drawn, "name"), "abcdefghijkl");
    await settled(drawn.form);
    const count = drawn.shell("name").querySelector(".datum-form__count");
    expect(count?.classList.contains("datum-form__count--over")).toBe(true);
    expect(count?.querySelector(".datum-form__count-status")?.textContent).toBe("2 characters over limit");
    expect(wrapper(drawn.root, "name").hasAttribute("data-over-limit")).toBe(true);
    expect(drawn.shell("name").classList.contains("datum-form__field--over-limit")).toBe(true);
    // The renderer's one region speaks it; the markup carries no live region of its own.
    expect(drawn.shell("name").querySelector("[aria-live]")).toBeNull();
  });

  it("marks the box read-only, never disabled, for a read-only field and in the read-only mode; disables it only when disabled", async () => {
    const field = await draw([text({ readOnly: true })]);
    expect(inputOf(field, "name").readOnly).toBe(true);
    expect(inputOf(field, "name").disabled).toBe(false);
    cleanUp();
    // Read-only stays focusable; a disabled box is not.
    const review = await draw([text()], { mode: "readonly" });
    expect(inputOf(review, "name").disabled).toBe(false);
    expect(inputOf(review, "name").readOnly).toBe(true);
    inputOf(review, "name").focus();
    expect(review.root.activeElement).toBe(inputOf(review, "name"));
    cleanUp();
    const off = await draw([text({ disabled: true })]);
    expect(inputOf(off, "name").disabled).toBe(true);
  });

  it("draws a textarea with its rows, count and a read-only copy at its line count", async () => {
    const drawn = await draw([{ id: "about", type: "textarea", configuration: { label: "About you", rows: 6, maxLength: 200, characterCount: true, placeholder: "Tell us" } }]);
    const area = drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement;
    expect(area.rows).toBe(6);
    expect(drawn.shell("about").querySelector(".datum-form__count-status")?.textContent).toBe("200 characters left");
    cleanUp();
    const plain = await draw([{ id: "about", type: "textarea", configuration: { label: "About you" } }]);
    expect((plain.shell("about").querySelector("textarea") as HTMLTextAreaElement).rows).toBe(4);
    cleanUp();
    const review = await draw([{ id: "about", type: "textarea", configuration: { label: "About you" } }], { mode: "readonly", values: { about: "one\ntwo\nthree" } });
    const copy = review.shell("about").querySelector("textarea") as HTMLTextAreaElement;
    expect(copy.rows).toBe(3);
    // Read-only, not disabled.
    expect(copy.readOnly).toBe(true);
    expect(copy.disabled).toBe(false);
  });

  it("draws a number as the browser's number box, with bounds, and as a text box with a number keyboard", async () => {
    const field: ComponentNode = { id: "age", type: "number", configuration: { label: "Age", min: 0, max: 120, step: 1, required: true, suffix: "years" } };
    const box = await draw([field], { controls: { number: "number" } });
    const native = inputOf(box, "age");
    expect(native.type).toBe("number");
    expect(native.getAttribute("min")).toBe("0");
    expect(native.getAttribute("max")).toBe("120");
    cleanUp();
    const asText = await draw([field], { controls: { number: "text" } });
    const plain = inputOf(asText, "age");
    expect(plain.type).toBe("text");
    expect(plain.getAttribute("inputmode")).toBe("numeric");
    expect(plain.getAttribute("spellcheck")).toBe("false");
    expect(plain.classList.contains("datum-form__control--number")).toBe(true);
  });

  it("draws a decimal keyboard for a number box drawn as text when the step is not whole", async () => {
    const drawn = await draw([{ id: "rate", type: "number", configuration: { label: "Rate", step: 0.5 } }], { controls: { number: "text" } });
    expect(inputOf(drawn, "rate").getAttribute("inputmode")).toBe("decimal");
  });
});

// The sizing is the renderer's readonly-sizing module, written once for every binding: the Datum
// textarea draws the box and leaves its height to the module (one measurement, one observer).
describe("datum textarea: sizing a read-only copy", () => {
  it("sizes a read-only textarea to its content once it has a layout, remeasures on a width change, and stops on unmount", async () => {
    const observed: Array<{ disconnect: () => void; callback: () => void; target?: Element }> = [];
    class StubObserver {
      entry = { disconnect: () => undefined, callback: () => undefined } as { disconnect: () => void; callback: () => void; target?: Element };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        this.entry.disconnect = vi.fn();
        observed.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.target = target;
      }
      disconnect(): void {
        this.entry.disconnect();
      }
    }
    vi.stubGlobal("ResizeObserver", StubObserver);
    // jsdom has no layout: give the box the numbers a browser would.
    const heights = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    vi.spyOn(HTMLTextAreaElement.prototype, "offsetHeight", "get").mockReturnValue(124);
    vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockReturnValue(120);
    let width = 300;
    vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    const drawn = await draw([{ id: "about", type: "textarea", configuration: { label: "About" } }], { mode: "readonly", values: { about: "one\ntwo" }, features: [createReadonlySizingFeature()] });
    const area = drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement;
    expect(area.style.height).toBe("124px");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.target).toBe(area);
    heights.mockReturnValue(200);
    observed[0]?.callback();
    // The width has not changed: the height-only change a measurement provokes is ignored.
    expect(area.style.height).toBe("124px");
    width = 200;
    observed[0]?.callback();
    expect(area.style.height).toBe("204px");
    drawn.form.unmount();
    expect(observed[0]?.disconnect).toHaveBeenCalled();
  });

  it("leaves an editable textarea at its rows", async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const drawn = await draw([{ id: "about", type: "textarea", configuration: { label: "About" } }], { features: [createReadonlySizingFeature()] });
    expect((drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement).style.height).toBe("");
  });

  it("leaves the height to the module: the adapter alone sizes nothing", async () => {
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    const drawn = await draw([{ id: "about", type: "textarea", configuration: { label: "About" } }], { mode: "readonly", values: { about: "one\ntwo" } });
    expect((drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement).style.height).toBe("");
  });
});

describe("datum choice fields: the tree", () => {
  it("draws radios in a named group, each option labelled, with a hint described by its own id", async () => {
    const drawn = await draw([choices("radio", { required: true, description: "How we reach you" })], { values: { pick: "email" } });
    const group = drawn.shell("pick");
    expect(group.localName).toBe("fieldset");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-labelledby")).toBe("pick__label");
    expect(group.getAttribute("aria-required")).toBe("true");
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(radios.map((radio) => radio.id)).toEqual(["pick__0", "pick__1", "pick__2"]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(radios[1]?.getAttribute("aria-labelledby")).toBe("pick__1__label");
    expect(radios[1]?.getAttribute("aria-describedby")).toBe("pick__1__hint");
    expect(group.querySelector("#pick__1__hint")?.textContent).toBe("Weekdays only");
  });

  it("draws an error on a radio group and describes the group by it", async () => {
    const drawn = await draw([choices("radio", { required: true })]);
    await drawn.runtime.validate();
    await settled(drawn.form);
    expect(drawn.shell("pick").getAttribute("aria-invalid")).toBe("true");
    expect(drawn.shell("pick").getAttribute("aria-describedby")).toBe("pick__error");
  });

  it("draws a group of checkboxes with the chosen ones checked", async () => {
    const drawn = await draw([choices("checkboxes", { description: "Pick any" })], { values: { pick: { email: true, post: true } } });
    const boxes = Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((box) => box.checked)).toEqual([true, false, true]);
    expect(drawn.shell("pick").hasAttribute("role")).toBe(false);
    expect(drawn.shell("pick").hasAttribute("aria-required")).toBe(false);
  });

  it("draws a lone checkbox with its label after the control's name", async () => {
    const drawn = await draw([{ id: "agree", type: "checkbox", configuration: { label: "I agree", required: true, description: "Terms apply" } }], { values: { agree: true } });
    const box = inputOf(drawn, "agree");
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(true);
    expect(box.getAttribute("aria-labelledby")).toBe("agree__label");
    expect(box.getAttribute("aria-describedby")).toBe("agree__description");
  });

  it("draws a select with its empty caption, the picked option, and a placeholder as the caption", async () => {
    const drawn = await draw([choices("select", { required: true, placeholder: "Choose one" })], { values: { pick: "phone" } });
    const select = drawn.shell("pick").querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("phone");
    const first = select.options[0];
    expect(first?.textContent).toBe("Choose one");
    expect(first?.disabled).toBe(true);
    expect(first?.hidden).toBe(true);
    cleanUp();
    const empty = await draw([choices("select")]);
    expect((empty.shell("pick").querySelector("select") as HTMLSelectElement).value).toBe("");
    expect((empty.shell("pick").querySelector("select") as HTMLSelectElement).options[0]?.selected).toBe(true);
  });

  it("draws the help of a choice group in its legend and describes the group by the bubble", async () => {
    const drawn = await draw([choices("radio", { tooltip: "Pick the quickest" })]);
    expect(drawn.shell("pick").getAttribute("aria-describedby")).toBe("pick__tooltip");
    expect(drawn.shell("pick").querySelector("legend #pick__label")?.textContent).toBe("Contact by");
  });
});

// ── The seams ──────────────────────────────────────────────────────────────────────────────

describe("datum field options: controls and field order change the drawn tree", () => {
  it("draws the parts in the order the form asks for, the DOM following", async () => {
    const order = ["label", "description", "error", "control"];
    const drawn = await draw([text({ required: true, description: "Hint" })], { fieldOrder: order });
    await drawn.runtime.validate();
    await settled(drawn.form);
    const ids = Array.from(drawn.shell("name").children).map((child) => child.id || child.querySelector("input")?.id);
    expect(ids).toEqual(["name__label", "name__description", "name__error", "name"]);
  });

  it("falls back to the engine's order for an order that does not name every part", async () => {
    const drawn = await draw([text({ description: "Hint" })], { fieldOrder: ["control", "label"] });
    expect(Array.from(drawn.shell("name").children).map((child) => child.id || child.querySelector("input")?.id)).toEqual(["name__label", "name__description", "name"]);
  });

  it("leaves out the ARIA states a design system's markup leaves out", async () => {
    const required = await draw([text({ required: true })], { controls: { ariaStates: "required" } });
    expect(inputOf(required, "name").hasAttribute("aria-invalid")).toBe(false);
    expect(inputOf(required, "name").getAttribute("aria-required")).toBe("true");
    cleanUp();
    const none = await draw([text({ required: true }), choices("radio", { required: true })], { controls: { ariaStates: "none" } });
    expect(inputOf(none, "name").hasAttribute("aria-required")).toBe(false);
    expect(none.shell("pick").hasAttribute("role")).toBe(false);
    // Without the state, the label's marker is what announces it.
    expect(none.shell("name").querySelector(".datum-form__required")?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("draws a plain inline error without the alert role", async () => {
    const drawn = await draw([text({ required: true })], { controls: { inlineErrors: "plain" } });
    await drawn.runtime.validate();
    await settled(drawn.form);
    expect(drawn.shell("name").querySelector("#name__error")?.hasAttribute("role")).toBe(false);
  });

  it("puts a choice group's state on each option, and the hint in the name, as the design systems do", async () => {
    const options: DatumFieldOptionsInput = { controls: { choiceState: "each", optionHint: "named", groupDescription: "none", groupError: "afterLegend" } };
    const drawn = await draw([choices("radio", { required: true, tooltip: "Help text" })], options);
    await drawn.runtime.validate();
    await settled(drawn.form);
    const radios = Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    expect(radios.every((radio) => radio.getAttribute("aria-invalid") === "true" && radio.getAttribute("aria-required") === "true")).toBe(true);
    expect(radios[1]?.getAttribute("aria-labelledby")).toBe("pick__1__label pick__1__hint");
    expect(radios[0]?.getAttribute("aria-describedby")).toBe("pick__error");
    // The group is described by nothing; the help falls back to a title.
    expect(drawn.shell("pick").hasAttribute("aria-describedby")).toBe(false);
    expect(drawn.shell("pick").getAttribute("title")).toBe("Help text");
    // The error stands between the legend and the options.
    expect(Array.from(drawn.shell("pick").children).slice(0, 2).map((child) => child.localName + (child.id ? `#${child.id}` : ""))).toEqual(["legend", "span#pick__error"]);
  });

  it("draws a listed select placeholder, a drawn chevron face and the form's textarea rows", async () => {
    const drawn = await draw([choices("select"), { id: "about", type: "textarea", configuration: { label: "About" } }], { controls: { selectPlaceholder: "listed", selectChevron: "drawn", textareaRows: 7 } });
    expect(drawn.shell("pick").querySelector(".datum-form__select-face select")).not.toBeNull();
    expect((drawn.shell("pick").querySelector("select") as HTMLSelectElement).options[0]?.hidden).toBe(false);
    expect((drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement).rows).toBe(7);
  });

  it("describes a lone checkbox's description as part of its name under optionHint named", async () => {
    const drawn = await draw([{ id: "agree", type: "checkbox", configuration: { label: "I agree", description: "Terms apply" } }], { controls: { optionHint: "named" } });
    expect(inputOf(drawn, "agree").getAttribute("aria-labelledby")).toBe("agree__label agree__description");
    expect(inputOf(drawn, "agree").hasAttribute("aria-describedby")).toBe(false);
  });
});

// ── What an adapter reports ────────────────────────────────────────────────────────────────

describe("datum text fields: what is written", () => {
  it("writes what is typed as an interim answer and reports the field left once", async () => {
    const drawn = await draw([text()]);
    const heard: string[] = [];
    drawn.runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, () => heard.push("committed"));
    type(inputOf(drawn, "name"), "Ann");
    expect(drawn.runtime.state().values.name).toBe("Ann");
    expect(heard).toEqual([]);
    inputOf(drawn, "name").dispatchEvent(new Event("change", { bubbles: true }));
    inputOf(drawn, "name").dispatchEvent(new Event("blur"));
    expect(heard).toEqual(["committed"]);
  });

  it("runs the leave-field check when a field is left without an edit", async () => {
    const drawn = await draw([text({ required: true })]);
    let checks = 0;
    const original = drawn.runtime.validatePath.bind(drawn.runtime);
    drawn.runtime.validatePath = (path: string) => {
      checks += 1;
      return original(path);
    };
    inputOf(drawn, "name").dispatchEvent(new Event("blur"));
    expect(checks).toBe(1);
    // An edit then a change and the blur after it check once.
    type(inputOf(drawn, "name"), "x");
    inputOf(drawn, "name").dispatchEvent(new Event("change", { bubbles: true }));
    inputOf(drawn, "name").dispatchEvent(new Event("blur"));
    expect(checks).toBe(2);
  });

  it("checks a field once when a redraw falls between its change and its blur", async () => {
    const drawn = await draw([text({ required: true })]);
    // An attempt to submit puts the form in the state where validating redraws the field.
    await drawn.runtime.validate();
    await settled(drawn.form);
    let checks = 0;
    const original = drawn.runtime.validatePath.bind(drawn.runtime);
    drawn.runtime.validatePath = (path: string) => {
      checks += 1;
      return original(path);
    };
    const box = inputOf(drawn, "name");
    type(box, "x");
    box.dispatchEvent(new Event("change", { bubbles: true }));
    // A browser runs microtasks (the redraw) between the change and the blur it dispatches.
    await settled(drawn.form);
    inputOf(drawn, "name").dispatchEvent(new Event("blur"));
    await settled(drawn.form);
    expect(checks).toBe(1);
  });

  it("keeps what was typed while the stored answer stands for it, and puts a changed answer back", async () => {
    const drawn = await draw([text()]);
    const box = inputOf(drawn, "name");
    type(box, "An");
    await settled(drawn.form);
    expect(inputOf(drawn, "name")).toBe(box);
    expect(box.value).toBe("An");
    drawn.runtime.setValue("name", "Reset by a rule");
    await settled(drawn.form);
    expect(box.value).toBe("Reset by a rule");
  });

  it("writes nothing for a read-only field or in the read-only mode, and draws the stored answer back", async () => {
    const drawn = await draw([text({ readOnly: true })], { values: { name: "locked" } });
    type(inputOf(drawn, "name"), "changed");
    await settled(drawn.form);
    expect(drawn.runtime.state().values.name).toBe("locked");
    expect(inputOf(drawn, "name").value).toBe("locked");
    cleanUp();
    const review = await draw([text()], { mode: "readonly", values: { name: "kept" } });
    type(inputOf(review, "name"), "changed");
    await settled(review.form);
    expect(review.runtime.state().values.name).toBe("kept");
  });

  it("writes a textarea's text as typed", async () => {
    const drawn = await draw([{ id: "about", type: "textarea", configuration: { label: "About" } }]);
    const area = drawn.shell("about").querySelector("textarea") as HTMLTextAreaElement;
    type(area, "line one\nline two");
    expect(drawn.runtime.state().values.about).toBe("line one\nline two");
  });

  it("writes a number box's value as a number, an emptied box as empty, and unreadable text as a bad input", async () => {
    const drawn = await draw([{ id: "age", type: "number", configuration: { label: "Age" } }], { controls: { number: "number" } });
    const box = inputOf(drawn, "age");
    type(box, "42");
    expect(drawn.runtime.state().values.age).toBe(42);
    type(box, "");
    expect(drawn.runtime.state().values.age).toBe("");
    // The browser reports a box holding "1e" as having no value but bad input.
    Object.defineProperty(box, "validity", { configurable: true, value: { badInput: true } });
    type(box, "");
    expect(drawn.runtime.state().values.age).toBe("");
    expect((drawn.runtime as unknown as { inputState(path: string): { badInput?: boolean } | undefined }).inputState("age")).toEqual({ badInput: true });
  });

  it("reads a number typed into a text box with grouped digits or the locale's decimal mark", async () => {
    const drawn = await draw([{ id: "total", type: "number", configuration: { label: "Total" } }], { controls: { number: "text" } });
    const box = inputOf(drawn, "total");
    type(box, "1,000.5");
    expect(drawn.runtime.state().values.total).toBe(1000.5);
    // The box keeps what was typed while it stands for the stored number.
    await settled(drawn.form);
    expect(box.value).toBe("1,000.5");
    type(box, "about ten");
    expect(drawn.runtime.state().values.total).toBe("about ten");
  });

  it("keeps a number box's text while it stands for the stored number (the caret survives a draw)", async () => {
    const drawn = await draw([{ id: "age", type: "number", configuration: { label: "Age" } }]);
    const box = inputOf(drawn, "age");
    type(box, "0002");
    await settled(drawn.form);
    expect(box.value).toBe("0002");
    expect(drawn.runtime.state().values.age).toBe(2);
    drawn.runtime.setValue("age", 7);
    await settled(drawn.form);
    expect(box.value).toBe("7");
  });
});

describe("datum choice fields: what is written", () => {
  it("writes the picked radio's value and reports the field settled", async () => {
    const drawn = await draw([choices("radio")]);
    const radios = Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    let checks = 0;
    const original = drawn.runtime.validatePath.bind(drawn.runtime);
    drawn.runtime.validatePath = (path: string) => {
      checks += 1;
      return original(path);
    };
    (radios[2] as HTMLInputElement).checked = true;
    (radios[2] as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.runtime.state().values.pick).toBe("post");
    expect(checks).toBe(1);
    await settled(drawn.form);
    expect(Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input")).map((radio) => radio.checked)).toEqual([false, false, true]);
  });

  it("stores a group of checkboxes as one boolean per option", async () => {
    const drawn = await draw([choices("checkboxes")]);
    const boxes = Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    (boxes[0] as HTMLInputElement).checked = true;
    (boxes[0] as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    (boxes[2] as HTMLInputElement).checked = true;
    (boxes[2] as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.runtime.state().values.pick).toEqual({ email: true, phone: false, post: true });
    await settled(drawn.form);
    (boxes[0] as HTMLInputElement).checked = false;
    (boxes[0] as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.runtime.state().values.pick).toEqual({ email: false, phone: false, post: true });
  });

  it("stores a lone checkbox as a boolean", async () => {
    const drawn = await draw([{ id: "agree", type: "checkbox", configuration: { label: "I agree" } }]);
    const box = inputOf(drawn, "agree");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.runtime.state().values.agree).toBe(true);
  });

  it("stores the picked option of a select and draws it selected", async () => {
    const drawn = await draw([choices("select")]);
    const select = drawn.shell("pick").querySelector("select") as HTMLSelectElement;
    select.value = "post";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.runtime.state().values.pick).toBe("post");
    await settled(drawn.form);
    expect((drawn.shell("pick").querySelector("select") as HTMLSelectElement).value).toBe("post");
    drawn.runtime.setValue("pick", "email");
    await settled(drawn.form);
    expect((drawn.shell("pick").querySelector("select") as HTMLSelectElement).value).toBe("email");
  });

  it("keeps every choice of a read-only field focusable, marked aria-readonly, and writes nothing", async () => {
    const drawn = await draw([choices("checkboxes", { readOnly: true })]);
    const boxes = Array.from(drawn.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    expect(boxes.every((box) => !box.disabled)).toBe(true);
    expect(boxes.every((box) => box.getAttribute("aria-readonly") === "true")).toBe(true);
    expect(drawn.shell("pick").querySelector(".datum-form__checkbox-option--disabled")).toBeNull();
    // The renderer's guard cancels the click before the box changes.
    (boxes[0] as HTMLInputElement).click();
    expect((boxes[0] as HTMLInputElement).checked).toBe(false);
    // A change that gets past it is refused anyway.
    (boxes[0] as HTMLInputElement).checked = true;
    (boxes[0] as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    await settled(drawn.form);
    expect(drawn.runtime.state().values.pick ?? {}).not.toHaveProperty("email", true);
    expect((drawn.shell("pick").querySelector("input") as HTMLInputElement).checked).toBe(false);
  });

  it("keeps a read-only radio group and select focusable, refuses the pick and the keys that change them, and lets Tab through", async () => {
    const drawn = await draw([choices("radio", { readOnly: true }, "radio"), choices("select", { readOnly: true }, "select")], { values: { radio: "phone", select: "phone" } });
    const radios = Array.from(drawn.shell("radio").querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(radios.every((radio) => !radio.disabled)).toBe(true);
    // A radio carries no read-only state of its own: the group does.
    expect(drawn.shell("radio").getAttribute("role")).toBe("radiogroup");
    expect(drawn.shell("radio").getAttribute("aria-readonly")).toBe("true");
    (radios[0] as HTMLInputElement).click();
    expect((radios[0] as HTMLInputElement).checked).toBe(false);
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    (radios[1] as HTMLInputElement).dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    const select = drawn.shell("select").querySelector("select") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.getAttribute("aria-readonly")).toBe("true");
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    select.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(drawn.root.activeElement).toBe(select);
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    select.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    select.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    // A change that gets past the guard writes nothing and is drawn back.
    select.value = "post";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settled(drawn.form);
    expect(drawn.runtime.state().values.select).toBe("phone");
    expect(select.value).toBe("phone");
  });

  it("draws read-only in the read-only mode as it does for a read-only field, and disables only a disabled field", async () => {
    const review = await draw([choices("checkboxes")], { mode: "readonly" });
    const boxes = Array.from(review.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    expect(boxes.every((box) => !box.disabled && box.getAttribute("aria-readonly") === "true")).toBe(true);
    cleanUp();
    const off = await draw([choices("checkboxes", { disabled: true })]);
    const offBoxes = Array.from(off.shell("pick").querySelectorAll<HTMLInputElement>("input"));
    expect(offBoxes.every((box) => box.disabled && !box.hasAttribute("aria-readonly"))).toBe(true);
    // A disabled field's clicks are the browser's to refuse: the guard leaves them alone.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    off.shell("pick").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("takes the read-only mark off again when a rule makes the field editable", async () => {
    const definition = [
      { id: "lock", type: "checkbox", configuration: { label: "Lock" } },
      { ...choices("select"), rules: { readonlyWhen: { kind: "path", path: "lock" } } }
    ] as ComponentNode[];
    const drawn = await draw(definition, { values: { lock: true } });
    const select = (): HTMLSelectElement => drawn.shell("pick").querySelector("select") as HTMLSelectElement;
    expect(select().getAttribute("aria-readonly")).toBe("true");
    drawn.runtime.setValue("lock", false);
    await settled(drawn.form);
    expect(select().hasAttribute("aria-readonly")).toBe(false);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    select().dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });
});

// ── Through the renderer ───────────────────────────────────────────────────────────────────

describe("datum text and choice adapters through mount", () => {
  it("draws every engine type of the two groups with the Datum binding, none unsupported", async () => {
    const drawn = await draw([
      text(),
      { id: "about", type: "textarea", configuration: { label: "About" } },
      { id: "age", type: "number", configuration: { label: "Age" } },
      choices("radio", {}, "radio"),
      choices("checkboxes", {}, "boxes"),
      choices("select", {}, "select"),
      { id: "agree", type: "checkbox", configuration: { label: "Agree" } }
    ]);
    expect(drawn.form.unsupported()).toEqual([]);
    for (const [id, name, kind] of [
      ["name", "datum-text", "text"],
      ["about", "datum-textarea", "textarea"],
      ["age", "datum-number-text", "number"],
      ["radio", "datum-radio", "radio"],
      ["boxes", "datum-checkboxes", "checkboxes"],
      ["select", "datum-select", "select"],
      ["agree", "datum-checkbox", "checkbox"]
    ] as const) {
      expect(drawn.form.adapterOf(id), id).toMatchObject({ name, from: "binding" });
      expect(wrapper(drawn.root, id).getAttribute("data-kind"), id).toBe(kind);
    }
    expect(drawn.errors).toEqual([]);
  });

  it("answers the drawing capabilities as data: prefix, suffix and count only where a box can carry them", () => {
    const binding = datumBinding();
    const answers = (type: string, kind: Parameters<typeof capabilityAnswers>[1]) => fieldCapabilitiesOf(binding, undefined, type)?.answers ?? capabilityAnswers(undefined, kind);
    expect(answers("text", "text")).toMatchObject({ notice: "drawn", pending: "degraded", tooltip: "drawn", prefix: "drawn", suffix: "drawn", characterCount: "drawn", hideLabel: "drawn", placeholder: "drawn" });
    expect(answers("textarea", "text")).toMatchObject({ prefix: "none", suffix: "none", characterCount: "drawn" });
    expect(answers("number", "number")).toMatchObject({ prefix: "drawn", suffix: "drawn", placeholder: "drawn" });
    expect(answers("select", "choice")).toMatchObject({ placeholder: "drawn", tooltip: "drawn" });
    expect(answers("radio", "choice")).toMatchObject({ placeholder: "none", tooltip: "drawn", hideLabel: "drawn" });
    expect(answers("checkboxes", "multichoice")).toMatchObject({ notice: "drawn", tooltip: "drawn" });
    expect(answers("checkbox", "boolean")).toMatchObject({ notice: "drawn", tooltip: "drawn" });
  });

  it("folds a pending check into the hint, since Datum draws it degraded, and flags the wrapper busy", async () => {
    quiet();
    const m = await mounted(definitionOf([text({ description: "Hint" })]), {
      binding: datumBinding(),
      features: [createFieldsFeature(), { id: "pending", fieldState: (state) => ({ ...state, pending: true }) }]
    });
    expect(wrapper(m.root, "name").querySelector("#name__description")?.textContent).toBe("Hint Checking this answer…");
    expect(wrapper(m.root, "name").getAttribute("aria-busy")).toBe("true");
    expect(wrapper(m.root, "name").hasAttribute("data-pending")).toBe(true);
  });

  it("is what a design-system binding without an adapter falls back to", async () => {
    quiet();
    const m = await mounted(definitionOf([choices("checkboxes"), text()]), {
      binding: { id: "ds", label: "DS", components: { text: datumTextComponents().text as never } },
      datum: datumBinding(),
      features: [createFieldsFeature()]
    });
    expect(m.form.adapterOf("pick")).toMatchObject({ name: "datum-checkboxes", from: "datum" });
    expect(m.form.unsupported()).toEqual(['pick: component "checkboxes"']);
    expect(wrapper(m.root, "pick").hasAttribute("data-fallback")).toBe(true);
  });
});

describe("the per-kind field state", () => {
  it("hands a text box its hints, affixes, help and count; a number its bounds", async () => {
    const states: Record<string, unknown> = {};
    quiet();
    const m = await mounted(
      definitionOf([
        text({ maxLength: 5, characterCount: true, placeholder: "Jane", prefix: "@", suffix: "!", tooltip: "Help", autocomplete: "name", inputmode: "email", spellcheck: true, minLength: 1, pattern: "[a-z]+" }),
        { id: "age", type: "number", configuration: { label: "Age", min: 1, max: 9, step: 2 } },
        choices("checkboxes"),
        choices("select", { placeholder: "Pick" }, "sel")
      ]),
      {
        binding: datumBinding(),
        features: [
          createFieldsFeature(),
          {
            id: "probe",
            fieldState: (state) => {
              states[state.componentId] = state;
            }
          }
        ]
      }
    );
    m.runtime.setValue("pick", { phone: true });
    await settled(m.form);
    const name = states.name as TextFieldState;
    expect(name).toMatchObject({ placeholder: "Jane", prefix: "@", suffix: "!", tooltip: "Help", autocomplete: "name", inputMode: "email", spellcheck: true, minLength: 1, maxLength: 5, pattern: "[a-z]+" });
    expect(name.characterCount).toEqual({ max: 5, count: 0, left: 5, over: false, limit: "You can enter up to 5 characters", limitId: "name__count", status: "5 characters left" });
    expect(states.age).toMatchObject({ min: 1, max: 9, step: 2 });
    expect(states.pick).toMatchObject({
      selected: ["phone"],
      options: [
        { id: "pick__0", value: "email", label: "Email", checked: false },
        { id: "pick__1", value: "phone", label: "Phone", hint: "Weekdays only", hintId: "pick__1__hint", checked: true },
        { id: "pick__2", value: "post", label: "Post", checked: false }
      ]
    });
    expect(states.sel).toMatchObject({ emptyLabel: "Pick", placeholder: "Pick" });
    expect(m.errors).toEqual([]);
  });

  it("words the count as it counts code points, and the empty count by the form's wording", async () => {
    const states: Record<string, TextFieldState> = {};
    quiet();
    const m = await mounted(definitionOf([text({ maxLength: 3, characterCount: true })]), {
      binding: datumBinding(),
      features: [
        createFieldsFeature(),
        {
          id: "probe",
          fieldState: (state) => {
            states[state.componentId] = state as TextFieldState;
          }
        }
      ]
    });
    m.runtime.setValue("name", "a😀b");
    await settled(m.form);
    expect(states.name?.characterCount).toMatchObject({ count: 3, left: 0, over: false, status: "0 characters left" });
    m.runtime.setValue("name", "a😀bc");
    await settled(m.form);
    expect(states.name?.characterCount).toMatchObject({ count: 4, left: -1, over: true, status: "1 character over limit" });
  });
});
