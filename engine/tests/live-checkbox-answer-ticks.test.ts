import { describe, expect, it } from "vitest";

import type { CheckboxesFieldState, CheckboxFieldState, FieldState } from "../form-engine/render/live/contract.js";
import type { PresentationField } from "../form-engine/render/core/presentation-tree.js";
import type { DrawContext } from "../form-engine/render/live/mount.js";
import { FIELD_STATE_BUILDERS } from "../form-engine/render/live/fields.js";

/*
 * What the renderer ticks from a stored answer: a lone checkbox only for `true` (a stored
 * "false", "no" or 1 is not its answer), and a checkboxes option for Datum's object of booleans
 * or for a list of chosen values.
 */

const items = [
  { value: "cat", label: "Cat" },
  { value: "dog", label: "Dog" },
  { value: "fish", label: "Fish" }
];
const node = { model: { node: { configuration: {} }, optionState: { items } } } as unknown as PresentationField;
const draw = {} as DrawContext;
const stateOf = (answer: unknown): FieldState => ({ id: "f", answer, value: "" }) as unknown as FieldState;

const ticked = (answer: unknown): boolean => (FIELD_STATE_BUILDERS.checkbox?.(stateOf(answer), node, draw) as CheckboxFieldState).checked;
const picked = (answer: unknown): readonly string[] => (FIELD_STATE_BUILDERS.checkboxes?.(stateOf(answer), node, draw) as CheckboxesFieldState).selected;

describe("lone checkbox: ticked by true only", () => {
  it("ticks true", () => {
    expect(ticked(true)).toBe(true);
  });

  it.each([["false"], ["no"], [1], ["true"], [false], [""], [undefined], [null]])("leaves %j unticked", (answer) => {
    expect(ticked(answer)).toBe(false);
  });
});

describe("checkboxes: the options an answer picks", () => {
  it("reads Datum's object of one boolean per option", () => {
    expect(picked({ cat: true, dog: false, fish: true })).toEqual(["cat", "fish"]);
  });

  it("reads a list of chosen values", () => {
    expect(picked(["cat", "dog"])).toEqual(["cat", "dog"]);
  });

  it("picks nothing from an empty or unreadable answer", () => {
    expect(picked("")).toEqual([]);
    expect(picked(null)).toEqual([]);
    expect(picked([])).toEqual([]);
  });
});
