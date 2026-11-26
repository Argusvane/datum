import { describe, expect, it } from "vitest";

import { hasPlaceholders, scanPlaceholders } from "../form-engine/core/text/placeholders.js";

describe("scanPlaceholders", () => {
  it("splits text into literal runs and trimmed paths, in order", () => {
    expect(scanPlaceholders("Page {{page}} of {{ pages }}")).toEqual([{ text: "Page " }, { path: "page" }, { text: " of " }, { path: "pages" }]);
    expect(scanPlaceholders("{{firstName}} {{lastName}}")).toEqual([{ path: "firstName" }, { text: " " }, { path: "lastName" }]);
    expect(scanPlaceholders("{{a}}{{b}}")).toEqual([{ path: "a" }, { path: "b" }]);
    expect(scanPlaceholders("Ref {{receipt.reference}}.")).toEqual([{ text: "Ref " }, { path: "receipt.reference" }, { text: "." }]);
  });

  it("is empty for empty text and one run for text without placeholders", () => {
    expect(scanPlaceholders("")).toEqual([]);
    expect(scanPlaceholders("Just words")).toEqual([{ text: "Just words" }]);
  });

  it("keeps a brace that opens no placeholder as literal text", () => {
    expect(scanPlaceholders("{ x } {{a{b}} }}")).toEqual([{ text: "{ x } {{a{b}} }}" }]);
    // Braces around nothing but whitespace are a placeholder with an empty path (it reads nothing).
    expect(scanPlaceholders("a {{ }} b")).toEqual([{ text: "a " }, { path: "" }, { text: " b" }]);
    expect(scanPlaceholders("{{{x}}}")).toEqual([{ text: "{" }, { path: "x" }, { text: "}" }]);
    expect(scanPlaceholders("{{x")).toEqual([{ text: "{{x" }]);
  });

  it("starts each scan afresh: a shared pattern carries no position between calls", () => {
    expect(hasPlaceholders("{{a}}")).toBe(true);
    expect(hasPlaceholders("{{a}}")).toBe(true);
    expect(hasPlaceholders("none")).toBe(false);
    expect(scanPlaceholders("{{a}} b")).toEqual(scanPlaceholders("{{a}} b"));
  });
});
