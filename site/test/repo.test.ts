import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two facts about the repository the site relies on: the demo bundles copied into public/demo/
// are build output and must never be committed, and the site says "open source"
// because the manifest says MIT.
describe("repository", () => {
  it("ignores the copied demo bundles", () => {
    const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
    expect(gitignore.split("\n")).toContain("site/public/demo/");
  });

  it("declares the MIT licence", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { license?: string };
    expect(manifest.license).toBe("MIT");
    const licence = readFileSync(new URL("../../LICENSE", import.meta.url), "utf8");
    expect(licence.startsWith("MIT License")).toBe(true);
  });
});
