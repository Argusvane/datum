import { describe, expect, it } from "vitest";

import { readTypedMonth, readTypedNumber } from "../form-engine/render/web-component/typed-answers.js";

describe("a number typed into a text box", () => {
  it("reads grouped digits and the locale's decimal mark, and plain numerals as before", () => {
    expect(readTypedNumber("1,000", "en")).toBe(1000);
    expect(readTypedNumber("1 000 000", "en")).toBe(1000000);
    expect(readTypedNumber("1,234.5", "en-GB")).toBe(1234.5);
    expect(readTypedNumber("-2,500", "en")).toBe(-2500);
    expect(readTypedNumber("1 000,5", "fr-CA")).toBe(1000.5);
    expect(readTypedNumber("1 000,5", "fr")).toBe(1000.5);
    expect(readTypedNumber("2,5", "fr")).toBe(2.5);
    expect(readTypedNumber("2.5", "fr")).toBe(2.5);
    expect(readTypedNumber("12", "cy")).toBe(12);
    expect(readTypedNumber(" 7 ", "en")).toBe(7);
    expect(readTypedNumber("1e3", "en")).toBe(1000);
  });

  it("reads nothing else, so validation still says it is not a number", () => {
    // Digits grouped in anything but threes are not a grouping.
    expect(readTypedNumber("1,5", "en")).toBeUndefined();
    expect(readTypedNumber("10,00", "en")).toBeUndefined();
    expect(readTypedNumber("12 kg", "en")).toBeUndefined();
    expect(readTypedNumber("abc", "en")).toBeUndefined();
    expect(readTypedNumber("", "en")).toBeUndefined();
  });
});

describe("a month typed into a date's text box", () => {
  it("reads digits, and the month's name or a short form in the form's language or English", () => {
    expect(readTypedMonth("2", "en")).toBe(2);
    expect(readTypedMonth("02", "en")).toBe(2);
    expect(readTypedMonth("Feb", "en")).toBe(2);
    expect(readTypedMonth("february", "en-GB")).toBe(2);
    expect(readTypedMonth("Sept.", "en")).toBe(9);
    expect(readTypedMonth("Chwefror", "cy")).toBe(2);
    expect(readTypedMonth("Feb", "cy")).toBe(2);
    expect(readTypedMonth("février", "fr")).toBe(2);
    expect(readTypedMonth("fevrier", "fr")).toBe(2);
  });

  it("reads nothing it cannot name one month by", () => {
    expect(readTypedMonth("13", "en")).toBeUndefined();
    expect(readTypedMonth("0", "en")).toBeUndefined();
    expect(readTypedMonth("ju", "en")).toBeUndefined();
    // "jui" starts both juin and juillet.
    expect(readTypedMonth("jui", "fr")).toBeUndefined();
    expect(readTypedMonth("Fbz", "en")).toBeUndefined();
  });
});
