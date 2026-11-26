import { describe, expect, it } from "vitest";

import { countCharacters, readLengthLimits } from "../form-engine/core/schema/length-limits.js";

describe("length limits", () => {
  it("reads only usable limits: finite, floored, at least one", () => {
    expect(readLengthLimits({ minLength: 2, maxLength: 10 })).toEqual({ minLength: 2, maxLength: 10 });
    expect(readLengthLimits({ maxLength: 2.9 })).toEqual({ maxLength: 2 });
    expect(readLengthLimits({ minLength: 0, maxLength: -1 })).toEqual({});
    expect(readLengthLimits({ minLength: "5", maxLength: Number.NaN })).toEqual({});
    expect(readLengthLimits(undefined)).toEqual({});
    expect(readLengthLimits([])).toEqual({});
  });

  it("drops both limits when the minimum exceeds the maximum", () => {
    // No value could satisfy them; enforcing either would only punish the form filler for
    // an authoring mistake, the same stance an uncompilable pattern gets.
    expect(readLengthLimits({ minLength: 9, maxLength: 2 })).toEqual({});
    expect(readLengthLimits({ minLength: 5, maxLength: 5 })).toEqual({ minLength: 5, maxLength: 5 });
  });

  it("reads the character count only beside a maximum", () => {
    expect(readLengthLimits({ maxLength: 10, characterCount: true })).toEqual({ maxLength: 10, characterCount: true });
    // Nothing to count down to; and only a real `true` asks for it.
    expect(readLengthLimits({ characterCount: true })).toEqual({});
    expect(readLengthLimits({ maxLength: 10, characterCount: "yes" })).toEqual({ maxLength: 10 });
    expect(readLengthLimits({ maxLength: 10, characterCount: false })).toEqual({ maxLength: 10 });
    expect(readLengthLimits({ minLength: 9, maxLength: 2, characterCount: true })).toEqual({});
  });

  it("counts characters as a person would", () => {
    expect(countCharacters("")).toBe(0);
    expect(countCharacters("abc")).toBe(3);
    expect(countCharacters("🙂🙂")).toBe(2);
    // Untrimmed: a limit is about the value as stored, emptiness is a separate question.
    expect(countCharacters("  a ")).toBe(4);
  });
});
