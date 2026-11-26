import { describe, expect, it } from "vitest";

// @ts-expect-error the generator is a plain .mjs script without typings
import { checkAll, metadataProblems, observedFrom } from "../scripts/gen-attribute-reference.mjs";

/**
 * The attribute reference (docs/reference/attributes.md) is generated from the
 * elements' observedAttributes plus a hand-written metadata table. These hold the committed
 * files to the real sources, and the check itself to failing when it should.
 */
const element = (names: string[]): string => `static get observedAttributes(): string[] {\n  return [${names.map((n) => `"${n}"`).join(", ")}];\n}`;

describe("the generated attribute reference", () => {
  it("is current against the real element sources", () => {
    expect(checkAll(), "run `node scripts/gen-attribute-reference.mjs` in packages/datum").toEqual([]);
  });

  it("fails for an observed attribute with no metadata and for a stale metadata entry", () => {
    const real = checkAll();
    expect(real).toEqual([]);
    const fake = {
      form: element(["definition", "brand-new-attribute"]),
      builder: element(["definition"])
    };
    const observed = observedFrom(fake);
    const problems: string[] = metadataProblems(observed);
    expect(problems).toContain('form: observed attribute "brand-new-attribute" has no entry in attribute-metadata.mjs');
    expect(problems.some((p) => p.startsWith('form: metadata entry "mode"') && p.includes("stale"))).toBe(true);
  });

  it("lets a pending metadata entry stand while its source has not landed", () => {
    const problems: string[] = metadataProblems({ form: [], builder: [] });
    expect(problems.filter((p) => p.includes('"server-checks"'))).toEqual([]);
  });

  it("refuses an element whose observedAttributes it cannot read", () => {
    expect(() => observedFrom({ form: "nothing here", builder: "" })).toThrow(/no readable observedAttributes/);
  });
});
