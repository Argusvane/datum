import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { keepsSourceMaps, stripSourceMaps, stripUnlessKept } from "../scripts/strip-source-maps.mjs";

/**
 * The last build step before the files are measured (scripts/strip-source-maps.mjs): a default
 * build ships no source maps and no comment that points at one; DATUM_SOURCE_MAPS=1 leaves the
 * folder as the bundler wrote it.
 */

function fakeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), "strip-source-maps-"));
  writeFileSync(join(dist, "datum-form.js"), "export{a};\n\n//# sourceMappingURL=datum-form.js.map");
  writeFileSync(join(dist, "datum-form.js.map"), "{}");
  writeFileSync(join(dist, "datum-form.iife.js"), "(function(){})();\n//# sourceMappingURL=datum-form.iife.js.map\n");
  writeFileSync(join(dist, "datum-form.iife.js.map"), "{}");
  writeFileSync(join(dist, "datum-form-core-AAAAAAAA.js"), 'import"./x.js";\n');
  writeFileSync(join(dist, "datum-form.css"), ".a{color:red}\n");
  mkdirSync(join(dist, "fonts"));
  writeFileSync(join(dist, "fonts", "DejaVuSans.ttf"), "font");
  return dist;
}

describe("the source-map switch", () => {
  it("keeps the maps only for DATUM_SOURCE_MAPS=1 (or true)", () => {
    expect(keepsSourceMaps({})).toBe(false);
    expect(keepsSourceMaps({ DATUM_SOURCE_MAPS: "" })).toBe(false);
    expect(keepsSourceMaps({ DATUM_SOURCE_MAPS: "0" })).toBe(false);
    expect(keepsSourceMaps({ DATUM_SOURCE_MAPS: "1" })).toBe(true);
    expect(keepsSourceMaps({ DATUM_SOURCE_MAPS: "true" })).toBe(true);
  });
});

describe("stripSourceMaps", () => {
  it("removes every map and the mapping comment beside it, and touches nothing else", () => {
    const dist = fakeDist();
    expect(stripSourceMaps(dist)).toEqual({ maps: 2, scripts: 2 });
    expect(readdirSync(dist).filter((name) => name.endsWith(".map"))).toEqual([]);
    expect(readFileSync(join(dist, "datum-form.js"), "utf8")).toBe("export{a};\n");
    expect(readFileSync(join(dist, "datum-form.iife.js"), "utf8")).toBe("(function(){})();\n");
    expect(readFileSync(join(dist, "datum-form-core-AAAAAAAA.js"), "utf8")).toBe('import"./x.js";\n');
    expect(readFileSync(join(dist, "datum-form.css"), "utf8")).toBe(".a{color:red}\n");
    expect(existsSync(join(dist, "fonts", "DejaVuSans.ttf"))).toBe(true);
  });

  it("leaves a script whose last line is not a mapping comment as it is", () => {
    const dist = fakeDist();
    writeFileSync(join(dist, "datum-wasm.js"), 'const s = "//# sourceMappingURL=a.map";\nexport{s};\n');
    stripSourceMaps(dist);
    expect(readFileSync(join(dist, "datum-wasm.js"), "utf8")).toBe('const s = "//# sourceMappingURL=a.map";\nexport{s};\n');
  });
});

describe("stripUnlessKept", () => {
  it("strips by default", () => {
    const dist = fakeDist();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stripUnlessKept(dist, "test", {});
    log.mockRestore();
    expect(existsSync(join(dist, "datum-form.js.map"))).toBe(false);
    expect(readFileSync(join(dist, "datum-form.js"), "utf8")).not.toContain("sourceMappingURL");
  });

  it("keeps maps and comments with DATUM_SOURCE_MAPS=1", () => {
    const dist = fakeDist();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stripUnlessKept(dist, "test", { DATUM_SOURCE_MAPS: "1" });
    log.mockRestore();
    expect(existsSync(join(dist, "datum-form.js.map"))).toBe(true);
    expect(readFileSync(join(dist, "datum-form.js"), "utf8")).toContain("//# sourceMappingURL=datum-form.js.map");
  });
});
