import { describe, expect, it } from "vitest";

import { readTypedMonth } from "../form-engine/render/web-component/typed-answers.js";

/*
 * A date's month is a Gregorian month, so the names a typed month is read against are the
 * Gregorian months' names in the form's language, whatever calendar the locale defaults to
 * (Persian's is the Solar Hijri calendar).
 */

describe("a month typed in a locale whose default calendar is not the Gregorian", () => {
  it("reads the Gregorian month's name in Persian", () => {
    expect(readTypedMonth("مارس", "fa")).toBe(3);
    expect(readTypedMonth("ژانویه", "fa")).toBe(1);
    expect(readTypedMonth("دسامبر", "fa-IR")).toBe(12);
  });

  it("does not read a Solar Hijri month's name as a Gregorian month", () => {
    // Farvardin and Esfand are Solar Hijri months, not April and March.
    expect(readTypedMonth("فروردین", "fa")).toBeUndefined();
    expect(readTypedMonth("اسفند", "fa")).toBeUndefined();
  });

  it("reads English names and digits as before", () => {
    expect(readTypedMonth("March", "fa")).toBe(3);
    expect(readTypedMonth("3", "fa")).toBe(3);
    expect(readTypedMonth("มกราคม", "th")).toBe(1);
  });
});
