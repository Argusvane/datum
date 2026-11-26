import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error The tester's file lookup is plain JavaScript with no declaration file.
import { resolveDsFile } from "../../binding-check/lib/ds-files.mjs";

const resolve = resolveDsFile as (roots: string[], pathname: string) => string | undefined;

// A binding package the way bindings/<id> lays one out: its design system pinned by npm alias, plus an
// unaliased copy of a sibling package that the component library pulls in transitively.
describe("datum-binding-check: the design system's files under a binding's pinned aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "datum-ds-files-"));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("package.json", JSON.stringify({
    name: "@argusvane/datum-binding-x",
    devDependencies: {
      "abgov-web-components-3.2.0": "npm:@abgov/web-components@3.2.0",
      "global-styles-9.2.2": "npm:@ongov/ontario-design-system-global-styles@9.2.2",
      "govuk-frontend-6.6.0": "npm:govuk-frontend@6.6.0"
    }
  }));
  put("node_modules/abgov-web-components-3.2.0/index.css", "alias 3.2.0");
  put("node_modules/global-styles-9.2.2/theme.css", "alias 9.2.2");
  put("node_modules/@ongov/ontario-design-system-global-styles/theme.css", "transitive copy");
  put("node_modules/govuk-frontend-6.6.0/all.js", "alias 6.6.0");
  put("vendor/saltire.css", "vendored");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const at = (path: string) => join(root, path);

  it("serves an address carrying the pinned release from that alias", () => {
    expect(resolve([root], "/node_modules/@abgov/web-components@3.2.0/index.css")).toBe(at("node_modules/abgov-web-components-3.2.0/index.css"));
  });

  it("answers 404 for an address carrying a release no alias pins", () => {
    expect(resolve([root], "/node_modules/@abgov/web-components@9.9.9/index.css")).toBeUndefined();
    expect(resolve([root], "/node_modules/govuk-frontend@6.5.0/all.js")).toBeUndefined();
    expect(resolve([root], "/node_modules/left-pad@1.3.0/index.js")).toBeUndefined();
  });

  it("prefers the pinned alias over an unaliased transitive copy, with or without the release", () => {
    expect(resolve([root], "/node_modules/@ongov/ontario-design-system-global-styles/theme.css")).toBe(at("node_modules/global-styles-9.2.2/theme.css"));
    expect(resolve([root], "/node_modules/@ongov/ontario-design-system-global-styles@9.2.2/theme.css")).toBe(at("node_modules/global-styles-9.2.2/theme.css"));
  });

  it("serves an unscoped package by name, the alias path itself and a vendored file as written", () => {
    expect(resolve([root], "/node_modules/govuk-frontend/all.js")).toBe(at("node_modules/govuk-frontend-6.6.0/all.js"));
    expect(resolve([root], "/node_modules/govuk-frontend-6.6.0/all.js")).toBe(at("node_modules/govuk-frontend-6.6.0/all.js"));
    expect(resolve([root], "/vendor/saltire.css")).toBe(at("vendor/saltire.css"));
    expect(resolve([root], "/node_modules/govuk-frontend/missing.js")).toBeUndefined();
    expect(resolve([root], "/../package.json")).toBeUndefined();
  });
});
