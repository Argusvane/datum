import { describe, expect, it } from "vitest";
import { defaultIconSet } from "@argusvane/datum-engine";

import { FONT_AWESOME_ICONS } from "../src/index.js";

describe("the bundle entry", () => {
  it("src/bundle.ts makes Font Awesome the default icon set and re-exports the package", async () => {
    const bundle = (await import("../src/bundle.js")) as Record<string, unknown>;
    expect(defaultIconSet()).toBe(FONT_AWESOME_ICONS);
    expect(Object.values(bundle)).toContain(FONT_AWESOME_ICONS);
  });
});
