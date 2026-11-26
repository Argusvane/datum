import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REPORT_PATH, renderReport } from "../scripts/a11y-report.mjs";

/**
 * The tracking document (docs/generated/theme-accessibility.md) is generated
 * from the committed baselines; this holds the committed document to what the baselines
 * render, so a refreshed baseline without `npm run a11y:report` — or a hand edit of the
 * document — shows up here.
 */
describe("the form accessibility tracking document", () => {
  it("is what the committed baselines render", () => {
    const committed = readFileSync(REPORT_PATH, "utf8");
    expect(committed, "docs/generated/theme-accessibility.md is stale: run `npm run a11y:report` in packages/datum").toBe(renderReport());
  });

  it("names every variant the browser audit covered, and the parts of the fixture", () => {
    const document = renderReport();
    expect(document).toContain("`datum-light`");
    expect(document).toContain("`datum-dark`");
    expect(document).toContain("## Variants by component");
    expect(document).toContain("| Variant | Text field |");
    expect(document).toContain("## Standards legend");
  });
});
