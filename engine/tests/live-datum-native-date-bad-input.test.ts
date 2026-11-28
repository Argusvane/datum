// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { definitionOf, settled, quiet, unmountAll, wrapper, type Mounted } from "./live-chrome-harness.js";
import { alertsOf, mountDatum } from "./live-datum-kit.js";

/*
 * The browser's own date box (`controls.date.control: "native"`) typed in part holds the empty
 * value with `validity.badInput`, and typing a part into an empty box fires no `input`. The
 * adapter reports such a box as the empty answer with `badInput`, when it is typed in and when
 * it is left, so validation says the date is not one ("Enter a real date") in place of
 * "required", or of nothing on an optional date. jsdom has no date box of its own, so the box's
 * `validity` is stood in for.
 */

afterEach(unmountAll);

const form = (configuration: Record<string, unknown> = {}) =>
  definitionOf([{ id: "born", type: "date", configuration: { label: "Date of birth", ...configuration } }] as never);

/** The native box, with a `validity.badInput` the test sets, as the browser's would read. */
function nativeBox(m: Mounted): { box: HTMLInputElement; unreadable: (bad: boolean) => void } {
  const box = wrapper(m.root, "born").querySelector('input[type="date"]') as HTMLInputElement;
  let bad = false;
  Object.defineProperty(box, "validity", { configurable: true, get: () => ({ badInput: bad, valid: !bad }) });
  return { box, unreadable: (value) => (bad = value) };
}

const fire = (box: HTMLInputElement, type: "input" | "change" | "blur"): void => {
  box.dispatchEvent(type === "blur" ? new FocusEvent("blur") : new Event(type, { bubbles: true, composed: true }));
};

describe("the browser's date box holding a date it cannot read", () => {
  it("says the date is not one when an optional box typed in part is left, with no input event", async () => {
    quiet();
    const m = await mountDatum(form(), { date: { control: "native" } });
    const { box, unreadable } = nativeBox(m);
    box.focus();
    // "12/05" typed, no year: the value stays empty and the browser fires no input.
    unreadable(true);
    fire(box, "blur");
    await settled(m.form);
    expect(m.runtime.inputState("born")).toEqual({ badInput: true });
    expect(m.runtime.state().values["born"] ?? "").toBe("");
    const errors = await m.runtime.validate();
    expect(errors.filter((error) => error.componentId === "born").map((error) => [error.code, error.parameters])).toEqual([["date", { badInput: true }]]);
    await settled(m.form);
    expect(alertsOf(m.root)).toEqual(["Enter a real date"]);
  });

  it("says the date is not one in place of required, as the box is typed in", async () => {
    quiet();
    const m = await mountDatum(form({ required: true }), { date: { control: "native" } });
    const { box, unreadable } = nativeBox(m);
    box.value = "2024-05-12";
    fire(box, "input");
    expect(m.runtime.state().values["born"]).toBe("2024-05-12");
    // The year deleted: the browser reports the empty value with badInput.
    box.value = "";
    unreadable(true);
    fire(box, "input");
    fire(box, "change");
    fire(box, "blur");
    await settled(m.form);
    const errors = await m.runtime.validate();
    expect(errors.filter((error) => error.componentId === "born").map((error) => error.code)).toEqual(["date"]);
    await settled(m.form);
    expect(alertsOf(m.root)).toEqual(["Enter a real date"]);
  });

  it("forgets it once the date is whole, or the box is emptied part by part and left", async () => {
    quiet();
    const m = await mountDatum(form(), { date: { control: "native" } });
    const { box, unreadable } = nativeBox(m);
    unreadable(true);
    fire(box, "blur");
    expect(m.runtime.inputState("born")).toEqual({ badInput: true });
    // Whole: the browser fires input with the value.
    unreadable(false);
    box.value = "2024-05-12";
    fire(box, "input");
    expect(m.runtime.inputState("born")).toBeUndefined();
    expect(m.runtime.state().values["born"]).toBe("2024-05-12");
    // In part again, then every part cleared: no input for the last step, read when left.
    box.value = "";
    unreadable(true);
    fire(box, "input");
    expect(m.runtime.inputState("born")).toEqual({ badInput: true });
    unreadable(false);
    fire(box, "blur");
    expect(m.runtime.inputState("born")).toBeUndefined();
    const errors = await m.runtime.validate();
    expect(errors.filter((error) => error.componentId === "born")).toEqual([]);
  });

  it("writes nothing when a box that holds nothing unreadable is left", async () => {
    quiet();
    const m = await mountDatum(form(), { date: { control: "native" } });
    const { box } = nativeBox(m);
    fire(box, "blur");
    await settled(m.form);
    expect(m.runtime.state().values["born"]).toBeUndefined();
    expect(m.runtime.inputState("born")).toBeUndefined();
  });

  it("drops what the box said while the date is not visible, even where a hidden answer is still checked", async () => {
    quiet();
    const shown = { visibleWhen: { kind: "binary", operator: "eq", left: { kind: "path", path: "show" }, right: { kind: "literal", value: true } } };
    const definition = definitionOf([
      { id: "show", type: "checkbox", configuration: { label: "Show" } },
      { id: "born", type: "date", configuration: { label: "Date of birth", hiddenValidationBehavior: "validate" }, rules: shown }
    ] as never);
    const m = await mountDatum(definition, { date: { control: "native" } });
    m.runtime.setValue("show", true);
    await settled(m.form);
    const { box, unreadable } = nativeBox(m);
    unreadable(true);
    fire(box, "blur");
    expect((await m.runtime.validate()).map((error) => error.code)).toEqual(["date"]);
    m.runtime.setValue("show", false);
    expect(await m.runtime.validate()).toEqual([]);
  });
});
