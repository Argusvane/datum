import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { KIT, load } from "./load.js";

const mod = () => load(join(KIT, "lib", "binding-package.mjs"));

const complete = { id: "demo", designSystem: "Demo", release: "1.0.0", bundle: "dist/demo.js", global: "DatumBindingDemo", budgetKb: 10 };

describe("binding package", () => {
  it("accepts a complete datumBinding block and says what is missing from an incomplete one", async () => {
    const { configProblems } = await mod();
    expect(configProblems(complete)).toEqual([]);
    expect(configProblems(undefined)).toEqual(["package.json has no datumBinding block"]);
    for (const [key, pattern] of [["id", /id/], ["designSystem", /designSystem/], ["release", /release/], ["bundle", /bundle/], ["global", /global/], ["budgetKb", /budgetKb/]] as const) {
      const broken = { ...complete, [key]: key === "budgetKb" ? 0 : "" };
      expect(configProblems(broken).join(), key).toMatch(pattern);
    }
    expect(configProblems({ ...complete, id: "Bad Id" }).join()).toMatch(/lower-case id/);
    expect(configProblems({ ...complete, global: "not valid" }).join()).toMatch(/global/);
  });

  it("describes bindings/govuk and Datum", async () => {
    const { loadBindingPackage, datumPackage, resolveBinding, renderAssets, listBindings } = await mod();
    const govuk = loadBindingPackage("govuk");
    expect(govuk.problems).toEqual([]);
    expect(govuk.config.id).toBe("govuk");
    expect(govuk.entry).toMatch(/src\/index\.ts$/);
    expect(renderAssets(govuk.assets).scripts[0]).toMatchObject({ classic: true });
    expect(resolveBinding("datum").isDatum).toBe(true);
    expect(datumPackage().referenceDir).toBeUndefined();
    expect(listBindings()).toContain("govuk");
    expect(() => loadBindingPackage("nope")).toThrow(/no binding "nope"/);
  });
});
