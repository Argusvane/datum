// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * THIRD_PARTY_NOTICES.md is read in an export of the repository, where `node_modules` does not exist: the licence text of
 * every copy of third-party material is a committed file, and the file names the notices give are files the tree holds.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const notices = readFileSync(join(REPO, "THIRD_PARTY_NOTICES.md"), "utf8");
const bindingIds = readdirSync(join(REPO, "bindings"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe("THIRD_PARTY_NOTICES.md", () => {
  it("names no licence file under node_modules as the text a reader finds in the repository", () => {
    const named = [...notices.matchAll(/`([^`]*node_modules[^`]*)`/g)].flatMap((match) => match[1] ?? []).filter((path) => /LICEN[CS]E/i.test(path));
    expect(named).toEqual([]);
  });

  it("names only committed licence files under bindings/ and site/", () => {
    const paths = [...notices.matchAll(/`((?:bindings|site)\/[^`\s*<>]*(?:LICEN[CS]E|OFL)[^`\s*<>]*)`/g)].flatMap((match) => match[1] ?? []);
    expect(paths.length).toBeGreaterThan(8);
    for (const path of paths) {
      expect(existsSync(join(REPO, path)), path).toBe(true);
    }
  });

  it("keeps a licence file beside the reference markup of every binding that has one, and names it", () => {
    const withReferences = bindingIds.filter((id) => existsSync(join(REPO, "bindings", id, "reference")) && readdirSync(join(REPO, "bindings", id, "reference")).some((name) => name.endsWith(".html")));
    expect(withReferences.length).toBe(9);
    for (const id of withReferences) {
      const files = readdirSync(join(REPO, "bindings", id, "reference")).filter((name) => /^LICENSE-.+\.txt$/.test(name));
      expect(files.length, `${id}/reference has a LICENSE-<package>.txt`).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(join(REPO, "bindings", id, "reference", file), "utf8").length, file).toBeGreaterThan(500);
        expect(notices, `${id}/reference/${file}`).toContain(`bindings/${id}/reference/${file}`);
      }
    }
  });

  it("keeps the upstream texts beside the copied token values", () => {
    for (const file of ["bindings/fluent/theme/LICENSE-fluentui-tokens.txt", "bindings/gcds/LICENSE-gcds-tokens.txt"]) {
      expect(readFileSync(join(REPO, file), "utf8"), file).toContain("Permission is hereby granted");
      expect(notices, file).toContain(file);
    }
  });

  it("calls the Liberation fonts GPL-2.0 with the font exception, unmodified, and not a Red Hat EULA", () => {
    expect(notices).not.toMatch(/Red Hat EULA/);
    expect(notices).toMatch(/GPL-2\.0 with the Liberation font exception/);
    expect(notices).toMatch(/copied unmodified/);
  });

  it("lists the Plex Mono 700 file, the Québec texts and the testing extra's opentelemetry-sdk, and no Font Awesome row for the FastAPI distributions", () => {
    expect(notices).toContain("site/scripts/fonts/OFL-ibmplexmono.txt");
    expect(notices).toContain("bindings/quebec/vendor/fonts/LICENSE-OFL-1.1.txt");
    expect(notices).toContain("bindings/quebec/vendor/fonts/LICENSE-Apache-2.0.txt");
    expect(notices).toContain("opentelemetry-sdk");
    expect(notices).not.toContain("Font Awesome Free 7.3.1 solid icons drawn inside");
  });

  it("does not list the QuickJS wasm engine among the files copied into dist", () => {
    const copied = notices.slice(notices.indexOf("## Copied beside the bundles at build time"), notices.indexOf("### Packages bundled into the scripts"));
    expect(copied).not.toContain("qjs-wasi.wasm");
  });
});
