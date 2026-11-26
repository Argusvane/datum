import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { KIT, load } from "./load.js";

const mod = () => load(join(KIT, "conformance.ts"));

describe("conformanceTarget", () => {
  it("names datum, a package in bindings/ by its id, and a package elsewhere by its module and assets file", async () => {
    const { conformanceTarget } = await mod();
    const { BINDINGS_ROOT } = await load(join(KIT, "lib", "binding-package.mjs"));
    expect(conformanceTarget({ isDatum: true, id: "datum" })).toEqual({ binding: "datum" });
    expect(conformanceTarget({ isDatum: false, id: "govuk", dir: join(BINDINGS_ROOT, "govuk"), entry: "/x/src/index.ts" })).toEqual({ binding: "govuk" });
    expect(conformanceTarget({ isDatum: false, id: "pico", dir: "/tmp/pico", entry: "/tmp/pico/src/index.ts", assetsFile: "/tmp/pico/binding-check.json" })).toEqual({ binding: "/tmp/pico/src/index.ts", assets: "/tmp/pico/binding-check.json" });
    expect(() => conformanceTarget({ isDatum: false, id: "pico", dir: "/tmp/pico" })).toThrow(/no binding module/);
  });

  it("passes a module path through with its assets and resolves anything else as a package", async () => {
    const { conformanceTargetOf } = await mod();
    expect(conformanceTargetOf("/a/src/index.ts", "/a/binding-check.json")).toEqual({ binding: "/a/src/index.ts", assets: "/a/binding-check.json" });
    expect(conformanceTargetOf("datum")).toEqual({ binding: "datum" });
    expect(() => conformanceTargetOf("no-such-binding")).toThrow(/no binding "no-such-binding"/);
  });
});
