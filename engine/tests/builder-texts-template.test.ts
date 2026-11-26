import { describe, expect, it } from "vitest";

import { ALL_BUILDER_TABLES, builderTextsTemplate } from "../scripts/builder-texts-template.js";

describe("builder texts template", () => {
  it("carries the union of every table, sorted, under the given locale", () => {
    const union = new Set(ALL_BUILDER_TABLES.flatMap((table) => Object.keys(table)));
    const template = builderTextsTemplate("fr");
    expect(Object.keys(template)).toEqual(["fr"]);
    const keys = Object.keys(template.fr ?? {});
    expect(keys.length).toBe(union.size);
    expect(keys).toEqual([...keys].sort());
    expect(template.fr?.["logic.group.form"]).toBe("This form");
    // The Move to... dialog's words are in the translator's template (they are keys of BuilderTextKey).
    expect(template.fr?.["move.title"]).toBe("Move “{name}”");
    expect(template.fr?.["components.skip"]).toBe("Skip to canvas");
    expect(Object.keys(builderTextsTemplate())).toEqual(["xx"]);
  });
});
