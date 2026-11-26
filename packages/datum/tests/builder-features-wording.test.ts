import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The attribute reference in docs/reference and the docs site's generated builder attribute page
 * say the same of a features word that names nothing: the builder reports it as datum-error and
 * leaves it out. Both are generated from attribute-metadata.mjs; they are read here side by side
 * so a stale copy of either shows.
 */

const root = resolve(__dirname, "../../..");
const SENTENCE = "A word that names nothing (a mistyped exclusion included) is reported as datum-error and left out";

describe("the builder features attribute", () => {
  it("is worded the same in the reference and on the docs site", () => {
    const reference = readFileSync(resolve(root, "docs/reference/attributes.md"), "utf8");
    const site = readFileSync(resolve(root, "site/docs/_generated/builder-attributes.md"), "utf8");
    expect(reference).toContain(SENTENCE);
    expect(site).toContain(SENTENCE);
    expect(site).not.toContain("warned about once and ignored");
  });
});
