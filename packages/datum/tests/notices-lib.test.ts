import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  bundleOfFile,
  bundleScopesOfDist,
  collectPackages,
  copyLicenceFiles,
  isBundleLicenceFile,
  licenceFilesFor,
  lockfileProblems,
  packageDirOf,
  packageProblems,
  parseLicenceFile,
  pdfFilesOf,
  readLegalComments,
  renderLicenceFile,
  versionMatchesPin
  // @ts-expect-error plain .mjs script without typings
} from "../scripts/notices-lib.mjs";

/**
 * What the third-party notices are made of (scripts/notices-lib.mjs): which bundle and scope a built
 * file belongs to, which package a source file comes from, that a bundle's licence file reads back
 * the same packages it was written with, and which licence files a host module copies.
 */

/** A project with an installed package (and the lockfile that installed it) in a scratch folder. */
function project(packages: Record<string, { version: string; license?: string; files?: Record<string, string>; lock?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "notices-lib-"));
  const lock: Record<string, { version: string }> = {};
  for (const [name, info] of Object.entries(packages)) {
    const dir = join(root, "node_modules", ...name.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: info.version, license: info.license ?? "MIT", author: "Ada" }));
    for (const [file, text] of Object.entries(info.files ?? {})) {
      writeFileSync(join(dir, file), text);
    }
    lock[`node_modules/${name}`] = { version: info.lock ?? info.version };
  }
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: lock }));
  return root;
}

describe("bundleOfFile", () => {
  it("names the bundle and scope of an entry, a classic script and a lazy chunk", () => {
    expect(bundleOfFile("datum-form.js")).toEqual({ bundle: "datum-form", scope: "core" });
    expect(bundleOfFile("datum-builder.iife.js")).toEqual({ bundle: "datum-builder", scope: "iife" });
    expect(bundleOfFile("datum-pdf.js")).toEqual({ bundle: "datum-pdf", scope: "pdf" });
    expect(bundleOfFile("datum-pdf-pages.js")).toEqual({ bundle: "datum-pdf-pages", scope: "pdf" });
    expect(bundleOfFile("datum-wasm.js")).toEqual({ bundle: "datum-wasm", scope: "core" });
    expect(bundleOfFile("datum-builder-journey-map-D-v439w2.js")).toEqual({ bundle: "datum-builder", scope: "core" });
  });

  it("puts the PDF feature's chunks of the form and the builder in the pdf scope", () => {
    expect(bundleOfFile("datum-builder-pdf-Z0lylkya.js")).toEqual({ bundle: "datum-builder", scope: "pdf" });
    expect(bundleOfFile("datum-builder-pdf-pages-DjwlwhTx.js")).toEqual({ bundle: "datum-builder", scope: "pdf" });
    expect(bundleOfFile("datum-form-pdf-service-DDdl_kQM.js")).toEqual({ bundle: "datum-form", scope: "pdf" });
    expect(bundleOfFile("datum-pdf-__vite-browser-external-BML0HLc6.js")).toEqual({ bundle: "datum-pdf", scope: "pdf" });
  });

  it("takes the scope from the feature manifest's PDF lists when it has them, so the rows follow what the hosts ship", () => {
    const manifest = {
      features: {
        pdf: { files: ["datum-pdf.js", "datum-builder-pdf-Z0lylkya.js", "datum-builder-__vite-browser-external-DPlEQ6od.js", "fonts/DejaVuSans.ttf"] },
        "pdf-pages": { files: ["datum-pdf-pages.js", "pdfjs/pdf.worker.min.mjs"] },
        journeys: { files: ["datum-builder-journey-map-D-v439w2.js"] }
      }
    };
    const pdfFiles = pdfFilesOf(manifest);
    expect([...pdfFiles].sort()).toEqual(["datum-builder-__vite-browser-external-DPlEQ6od.js", "datum-builder-pdf-Z0lylkya.js", "datum-pdf-pages.js", "datum-pdf.js", "fonts/DejaVuSans.ttf", "pdfjs/pdf.worker.min.mjs"]);
    // Named pdf, shipped by the UI module: core.
    expect(bundleOfFile("datum-builder-pdf-layout-selection-8HlJJi5X.js", pdfFiles)).toEqual({ bundle: "datum-builder", scope: "core" });
    expect(bundleOfFile("datum-form-pdf-values-AAAAAAAA.js", pdfFiles)).toEqual({ bundle: "datum-form", scope: "core" });
    // Named like core, shipped by the PDF module: pdf.
    expect(bundleOfFile("datum-builder-__vite-browser-external-DPlEQ6od.js", pdfFiles)).toEqual({ bundle: "datum-builder", scope: "pdf" });
    // The entries of the PDF bundles and the ones outside the feature.
    expect(bundleOfFile("datum-pdf.js", pdfFiles)).toEqual({ bundle: "datum-pdf", scope: "pdf" });
    expect(bundleOfFile("datum-pdf-pages.js", pdfFiles)).toEqual({ bundle: "datum-pdf-pages", scope: "pdf" });
    expect(bundleOfFile("datum-form.js", pdfFiles)).toEqual({ bundle: "datum-form", scope: "core" });
    expect(bundleOfFile("datum-builder-journey-map-D-v439w2.js", pdfFiles)).toEqual({ bundle: "datum-builder", scope: "core" });
    // The classic script keeps its own scope, and a manifest with no PDF lists puts nothing in the pdf scope.
    expect(bundleOfFile("datum-form.iife.js", pdfFiles)).toEqual({ bundle: "datum-form", scope: "iife" });
    expect(bundleOfFile("datum-builder-pdf-Z0lylkya.js", pdfFilesOf({ features: {} }))).toEqual({ bundle: "datum-builder", scope: "core" });
  });

  it("knows no bundle in the programs and the stylesheets", () => {
    expect(bundleOfFile("datum-pdf-program.js")).toBeNull();
    expect(bundleOfFile("datum-sandbox-program.js")).toBeNull();
    expect(bundleOfFile("datum-form.css")).toBeNull();
  });
});

describe("packageDirOf", () => {
  const at = (...parts: string[]) => `${sep}${parts.join(sep)}`;

  it("finds the nearest package folder, scoped or not, and the innermost of a nested one", () => {
    expect(packageDirOf(at("repo", "node_modules", "lit-html", "src", "a.js"))).toBe(at("repo", "node_modules", "lit-html"));
    expect(packageDirOf(at("repo", "node_modules", "@codemirror", "view", "dist", "index.js"))).toBe(at("repo", "node_modules", "@codemirror", "view"));
    expect(packageDirOf(at("repo", "node_modules", "a", "node_modules", "b", "i.js"))).toBe(at("repo", "node_modules", "a", "node_modules", "b"));
  });

  it("is null for the repository's own code, its linked packages and the bundler's virtual modules", () => {
    expect(packageDirOf(at("repo", "engine", "form-engine", "a.ts"))).toBeNull();
    expect(packageDirOf(at("repo", "node_modules", "@argusvane", "datum-engine", "a.ts"))).toBeNull();
    expect(packageDirOf("\0rolldown:runtime")).toBeNull();
  });
});

describe("the packages of a bundle", () => {
  it("reads name, version, licence and the licence files of each package once, with the scopes it is carried in", () => {
    const root = project({ "lit-html": { version: "3.3.3", license: "BSD-3-Clause", files: { LICENSE: "BSD text\r\n" } }, "@x/y": { version: "1.0.0", files: { "LICENSE.md": "MIT text" } } });
    const packages = collectPackages([
      { file: join(root, "node_modules", "lit-html", "a.js"), scope: "core" },
      { file: join(root, "node_modules", "lit-html", "b.js"), scope: "pdf" },
      { file: join(root, "node_modules", "@x", "y", "i.js"), scope: "core" },
      { file: join(root, "src", "own.ts"), scope: "core" }
    ]);
    expect([...packages.keys()]).toEqual(["lit-html@3.3.3", "@x/y@1.0.0"]);
    const lit = packages.get("lit-html@3.3.3");
    expect(lit.license).toBe("BSD-3-Clause");
    expect([...lit.scopes].sort()).toEqual(["core", "pdf"]);
    expect(lit.texts).toEqual([{ file: "LICENSE", text: "BSD text" }]);
    expect(packageProblems(packages)).toEqual([]);
  });

  it("reports a package whose version the lockfile does not pin, and one with no licence text", () => {
    const root = project({ stale: { version: "2.0.0", lock: "1.0.0", files: { LICENSE: "MIT text" } }, bare: { version: "1.0.0" } });
    const packages = collectPackages([
      { file: join(root, "node_modules", "stale", "a.js"), scope: "core" },
      { file: join(root, "node_modules", "bare", "a.js"), scope: "core" }
    ]);
    const problems = packageProblems(packages);
    expect(problems.some((line: string) => line.includes("pins 1.0.0, node_modules holds 2.0.0"))).toBe(true);
    expect(problems.some((line: string) => line.includes("bare 1.0.0 (MIT) ships no licence file"))).toBe(true);
    expect(lockfileProblems(packages.get("bare@1.0.0"))).toEqual([]);
  });
});

describe("a bundle's licence file", () => {
  it("reads back the packages, licences, scopes and texts it was written with", () => {
    const root = project({ "lit-html": { version: "3.3.3", license: "BSD-3-Clause", files: { LICENSE: "BSD text\nline two" } }, "@x/y": { version: "1.0.0", files: { LICENSE: "MIT text" } } });
    const packages = collectPackages([
      { file: join(root, "node_modules", "lit-html", "a.js"), scope: "core" },
      { file: join(root, "node_modules", "@x", "y", "i.js"), scope: "pdf" }
    ]);
    const text = renderLicenceFile({ bundle: "datum-form", covers: "It covers datum-form.js.", packages, legalComments: "/**\n * @license\n * Copyright 2017 Google LLC\n */" });
    expect(parseLicenceFile(text)).toEqual([
      { name: "@x/y", version: "1.0.0", license: "MIT", scopes: ["pdf"], text: "MIT text" },
      { name: "lit-html", version: "3.3.3", license: "BSD-3-Clause", scopes: ["core"], text: "BSD text\nline two" }
    ]);
    expect(text).toContain("Legal comments found in the bundled sources");
    expect(text).toContain("Copyright 2017 Google LLC");
  });

  it("says so when a bundle carries no third-party package", () => {
    const text = renderLicenceFile({ bundle: "datum-engine", covers: "It covers datum-engine.js.", packages: new Map() });
    expect(text).toContain("Packages: none.");
    expect(parseLicenceFile(text)).toEqual([]);
  });

  it("collects the legal comments of every format once and copies a package's licence files unchanged", () => {
    const dist = mkdtempSync(join(tmpdir(), "notices-dist-"));
    writeFileSync(join(dist, "datum-form.legal-comments.es.txt"), "/*! a */\n\n/*! b */\n");
    writeFileSync(join(dist, "datum-form.legal-comments.iife.txt"), "/*! b */\n");
    expect(readLegalComments(dist, "datum-form")).toEqual({
      comments: ["/*! a */", "/*! b */"],
      files: ["datum-form.legal-comments.es.txt", "datum-form.legal-comments.iife.txt"]
    });
    const root = project({ "@x/y": { version: "1.0.0", files: { LICENSE: "MIT text\r\n" } } });
    const packages = collectPackages([{ file: join(root, "node_modules", "@x", "y", "i.js"), scope: "core" }]);
    expect(copyLicenceFiles(packages, dist)).toEqual(["LICENSE.x__y.txt"]);
    expect(readFileSync(join(dist, "LICENSE.x__y.txt"), "utf8")).toBe("MIT text\r\n");
  });
});

describe("the licence files a host module copies", () => {
  const available = ["datum-form.LICENSE.txt", "datum-builder.LICENSE.txt", "datum-pdf.LICENSE.txt", "datum-pdf-pages.LICENSE.txt", "datum-wasm.LICENSE.txt", "datum-pdf-program.LICENSE.txt"];

  it("names a bundle's licence file", () => {
    expect(isBundleLicenceFile("datum-form.LICENSE.txt")).toBe(true);
    expect(isBundleLicenceFile("datum-pdf-program.LICENSE.txt")).toBe(true);
    expect(isBundleLicenceFile("fonts/LICENSE")).toBe(false);
    expect(isBundleLicenceFile("datum-form.js")).toBe(false);
  });

  it("is one file per bundle the module holds the main file of", () => {
    expect(licenceFilesFor(["datum-form.js", "datum-form-core-AAAAAAAA.js", "datum-builder.js", "datum-builder-journey-map-D-v439w2.js", "datum-wasm.js", "datum-form.css"], available)).toEqual({
      files: ["datum-builder.LICENSE.txt", "datum-form.LICENSE.txt", "datum-wasm.LICENSE.txt"],
      missing: []
    });
    expect(licenceFilesFor(["datum-pdf.js", "datum-pdf-pages.js", "pdfjs/LICENSE"], available)).toEqual({
      files: ["datum-pdf-pages.LICENSE.txt", "datum-pdf.LICENSE.txt"],
      missing: []
    });
    expect(licenceFilesFor(["datum-sandbox-program.js", "datum-pdf-program.js", "fonts/DejaVuSans.ttf"], available)).toEqual({ files: ["datum-pdf-program.LICENSE.txt"], missing: [] });
  });

  it("gives a licence file to one module only: the PDF chunks of the form and the builder carry none", () => {
    const pdfModule = ["datum-pdf.js", "datum-pdf-pages.js", "datum-form-pdf-AAAAAAAA.js", "datum-builder-pdf-Z0lylkya.js"];
    const uiModule = ["datum-form.js", "datum-builder.js", "datum-form-core-AAAAAAAA.js"];
    const pdf = licenceFilesFor(pdfModule, available).files;
    const ui = licenceFilesFor(uiModule, available).files;
    expect(pdf).toEqual(["datum-pdf-pages.LICENSE.txt", "datum-pdf.LICENSE.txt"]);
    expect(pdf.filter((file: string) => ui.includes(file))).toEqual([]);
  });

  it("names a licence file a shipped bundle lacks, and copies nothing for a module with no bundle", () => {
    expect(licenceFilesFor(["datum-form.js"], [])).toEqual({ files: [], missing: ["datum-form.LICENSE.txt"] });
    expect(licenceFilesFor(["datum-form.js", "datum-wasm.js"], ["datum-wasm.LICENSE.txt"])).toEqual({ files: ["datum-wasm.LICENSE.txt"], missing: ["datum-form.LICENSE.txt"] });
    expect(licenceFilesFor(["datum-pdf-program.js"], [])).toEqual({ files: [], missing: ["datum-pdf-program.LICENSE.txt"] });
    expect(licenceFilesFor(["feature-files.json"], available)).toEqual({ files: [], missing: [] });
  });
});

describe("a version held to its pin", () => {
  it("accepts the same version, and a leading part of the pin that ends at a separator", () => {
    expect(versionMatchesPin("1.2.1", "1.2.1")).toBe(true);
    expect(versionMatchesPin("1.78", "1.78.1")).toBe(true);
    expect(versionMatchesPin("1.2.1", "1.2.1.RELEASE")).toBe(true);
    expect(versionMatchesPin("1.3.2", "1.3.2 / 33.7.1-jre")).toBe(true);
  });

  it("refuses a version that is only a string prefix of the pin", () => {
    expect(versionMatchesPin("1.2.1", "1.2.10")).toBe(false);
    expect(versionMatchesPin("1.2.1", "1.2.1a")).toBe(false);
    expect(versionMatchesPin("2.37", "2.370.1")).toBe(false);
    expect(versionMatchesPin("1.2.10", "1.2.1")).toBe(false);
    expect(versionMatchesPin("1.3.0", "1.2.1")).toBe(false);
  });
});

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const BUILT = existsSync(join(DIST, "feature-files.json")) && existsSync(join(DIST, "datum-form.js"));

describe.skipIf(!BUILT)("bundleScopesOfDist: the scopes bundle-notices uses follow the built feature manifest", () => {
  it("puts a built file in the pdf scope exactly when the manifest's pdf lists hold it", () => {
    const manifest = JSON.parse(readFileSync(join(DIST, "feature-files.json"), "utf8"));
    const pdf = pdfFilesOf(manifest);
    const scopeOf = bundleScopesOfDist(DIST);
    let checked = 0;
    for (const name of readdirSync(DIST).filter((file) => file.endsWith(".js"))) {
      const kind = scopeOf(name);
      if (kind === null || kind.scope === "iife") continue;
      expect({ name, scope: kind.scope }).toEqual({ name, scope: pdf.has(name) ? "pdf" : "core" });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
