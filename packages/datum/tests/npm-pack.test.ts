// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { renderLicenceFile } from "../scripts/notices-lib.mjs";
// @ts-expect-error plain .mjs script without typings
import { ALLOWED_PRIVATE_IMPORTS, dryRunPack, filesOf, packProblems, sizeReport } from "../../../scripts/npm/pack-check.mjs";
// @ts-expect-error plain .mjs script without typings
import { noticeText, entryTargets } from "../../../scripts/npm/prepack.mjs";
// @ts-expect-error plain .mjs script without typings
import { archiveBundles, archiveMaps } from "../scripts/release-assets.mjs";

// @ts-expect-error plain .mjs script without typings
import { clearPackFolder, integrityText, tarballName } from "../../../scripts/npm/release.mjs";
// @ts-expect-error plain .mjs script without typings
import { rewriteSpecifiers, packageOf } from "../../../scripts/npm/build-types.mjs";

/**
 * What the npm tarballs carry (scripts/npm): the checks every published package is held to, shown on
 * small synthetic packages (each rule fails the one way it should), the NOTICE the prepack writes, the
 * declaration rewrite that takes the private packages out of the types, and, when dist is built, the
 * real tarball of this package: its files, its size and what it must not hold.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const scratch = mkdtempSync(join(tmpdir(), "datum-npm-pack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MANIFEST = {
  name: "@argusvane/example",
  version: "1.0.0",
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/argusvane/datum.git" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
  files: ["dist", "README.md", "LICENSE", "NOTICE"],
  publishConfig: { access: "public", provenance: true }
};

/** A package folder holding `files` (path -> text) and the manifest, as `{ folder, files }` for packProblems. */
function pack(files: Record<string, string>, manifest: Record<string, unknown> = MANIFEST) {
  const folder = mkdtempSync(join(scratch, "pkg-"));
  const all: Record<string, string> = { "package.json": JSON.stringify(manifest), LICENSE: "MIT", NOTICE: "notice", "README.md": "# readme", "dist/index.js": "export {};", "dist/index.d.ts": "export {};", ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return { folder, files: filesOf(folder) as Array<{ path: string; size: number }> };
}

const problemsOf = (files: Record<string, string>, manifest?: Record<string, unknown>): string[] => {
  const made = pack(files, manifest);
  return packProblems(made.folder, made.files);
};

describe("pack-check: what a tarball must and must not hold", () => {
  it("accepts a package with its licence files, README, entry points and nothing else", () => {
    expect(problemsOf({})).toEqual([]);
  });

  it("names a missing LICENSE, NOTICE or README, and an entry point the manifest points at but the files lack", () => {
    const made = pack({});
    const without = (name: string) => made.files.filter((file) => file.path !== name);
    for (const name of ["LICENSE", "NOTICE", "README.md", "dist/index.js"]) {
      expect(packProblems(made.folder, without(name)).join("\n"), name).toContain(name);
    }
  });

  it("refuses TypeScript source, tests, source maps and dependency folders, and lets a declaration file through", () => {
    const problems = problemsOf({ "dist/leak.ts": "x", "dist/a.test.js": "x", "dist/index.js.map": "{}", "dist/node_modules/x/index.js": "x", "src/index.ts": "x" });
    const text = problems.join("\n");
    for (const path of ["dist/leak.ts", "dist/a.test.js", "dist/index.js.map", "dist/node_modules/x/index.js", "src/index.ts"]) {
      expect(text, path).toContain(path);
    }
    expect(text).not.toContain("dist/index.d.ts");
  });

  it("refuses a text that names the machine it was built on, and the checkout", () => {
    const home = ["", "Users", "ada", "build", "x.js"].join("/");
    const runner = ["", "home", "runner", "work", "datum", "x.js"].join("/");
    expect(problemsOf({ "dist/a.js": `// ${home}` }).join("\n")).toContain("dist/a.js");
    expect(problemsOf({ "dist/b.js": `// ${runner}` }).join("\n")).toContain("dist/b.js");
    expect(problemsOf({ "dist/c.js": `// ${join(here, "..", "..", "..")}` }).join("\n")).toContain("checkout");
    expect(problemsOf({ "dist/d.js": "// a relative path ../../engine/x.js is fine" })).toEqual([]);
  });

  it("refuses a manifest a consumer cannot install", () => {
    const refused = (change: Record<string, unknown>) => problemsOf({}, { ...MANIFEST, ...change }).join("\n");
    expect(refused({ private: true })).toContain("private");
    expect(refused({ dependencies: { "@argusvane/datum-engine": "0.1.0" } })).toContain("not published");
    expect(refused({ dependencies: { left: "file:../left" } })).toContain("cannot install");
    expect(refused({ peerDependencies: { left: "workspace:*" } })).toContain("cannot install");
    expect(refused({ publishConfig: { access: "public" } })).toContain("provenance");
    expect(refused({ publishConfig: { provenance: true } })).toContain("access");
    expect(refused({ repository: undefined })).toContain("repository.url");
    expect(refused({ files: undefined })).toContain("allowlist");
    expect(refused({ license: "ISC" })).toContain("license");
    // A devDependency is not installed by a consumer: a file: link there is how the workspace builds.
    expect(refused({ devDependencies: { engine: "file:../../engine" } })).toBe("");
  });

  it("refuses a file that imports a package that is not published, bundled or declaration, except the guarded worker import", () => {
    expect(problemsOf({ "dist/a.js": 'import { x } from "@argusvane/datum-engine";' }).join("\n")).toContain("dist/a.js");
    expect(problemsOf({ "dist/b.d.ts": 'export * from "@argusvane/datum-pdf-kernel/quickjs";' }).join("\n")).toContain("dist/b.d.ts");
    expect(problemsOf({ "dist/c.js": 'const m = await import("@argusvane/datum-submissions");' }).join("\n")).toContain("dist/c.js");
    expect(problemsOf({ "dist/d.js": 'import{x}from"@argusvane/datum-quickjs-wasm-host";' }).join("\n")).toContain("dist/d.js");
    expect(ALLOWED_PRIVATE_IMPORTS).toEqual(["@argusvane/datum-quickjs-wasm-host/worker"]);
    expect(problemsOf({ "dist/e.js": 'import("@argusvane/datum-quickjs-wasm-host/worker")' })).toEqual([]);
    // Prose that names the package is not an import.
    expect(problemsOf({ "dist/f.js": "// reads @argusvane/datum-engine from the bundle" })).toEqual([]);
  });

  it("reports sizes: totals and the largest entries", () => {
    const report = sizeReport("@argusvane/example", [{ path: "dist/a.js", size: 3 * 1024 * 1024 }, { path: "README.md", size: 100 }], 1024 * 1024);
    expect(report).toContain("2 files, 1.00 MB packed, 3.00 MB unpacked");
    expect(report).toContain("dist/");
  });
});

describe("prepack: the NOTICE", () => {
  it("lists each bundle's packages with the file that holds their text, and the asset licence files", () => {
    const folder = mkdtempSync(join(scratch, "notice-"));
    mkdirSync(join(folder, "dist", "fonts"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@argusvane/example" }));
    const packages = new Map([["lit-html@3.3.3", { name: "lit-html", version: "3.3.3", license: "BSD-3-Clause", homepage: "", texts: [{ file: "LICENSE", text: "BSD" }], scopes: new Set(["core"]) }]]);
    writeFileSync(join(folder, "dist", "datum-form.LICENSE.txt"), renderLicenceFile({ bundle: "datum-form", covers: "x", packages }));
    writeFileSync(join(folder, "dist", "fonts", "LICENSE"), "fonts");
    const notice = noticeText(folder) as string;
    expect(notice).toContain("Copyright (c) 2026 Argusvane. Licensed under the MIT License (see LICENSE).");
    expect(notice).toContain("lit-html 3.3.3 (BSD-3-Clause): dist/datum-form.LICENSE.txt");
    expect(notice).toContain("dist/fonts/LICENSE");
    // The bundle's own licence file is named once, as the carrier of the packages, not as an asset licence.
    expect(notice).not.toContain("  dist/datum-form.LICENSE.txt\n");
  });

  it("names the GPL licence of the Liberation fonts rather than leaving it to a file name", () => {
    const folder = mkdtempSync(join(scratch, "notice-liberation-"));
    mkdirSync(join(folder, "dist", "pdfjs", "standard_fonts"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@argusvane/example" }));
    writeFileSync(join(folder, "dist", "pdfjs", "standard_fonts", "LICENSE_LIBERATION"), "GPL 2 with the exception");
    writeFileSync(join(folder, "dist", "pdfjs", "standard_fonts", "LICENSE_FOXIT"), "foxit");
    writeFileSync(join(folder, "dist", "a.LICENSE.txt"), renderLicenceFile({ bundle: "a", covers: "x", packages: new Map() }));
    const notice = noticeText(folder) as string;
    expect(notice).toContain("dist/pdfjs/standard_fonts/LICENSE_LIBERATION");
    expect(notice).toContain("The four Liberation Sans faces in dist/pdfjs/standard_fonts/ are pdf.js's standard fonts, copied unmodified");
    expect(notice).toContain("GNU General\nPublic License, version 2, with the Liberation font exception");
    // A package that does not ship the faces says nothing about them.
    const bare = mkdtempSync(join(scratch, "notice-bare-"));
    mkdirSync(join(bare, "dist", "fonts"), { recursive: true });
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "@argusvane/example" }));
    writeFileSync(join(bare, "dist", "fonts", "LICENSE"), "fonts");
    writeFileSync(join(bare, "dist", "a.LICENSE.txt"), renderLicenceFile({ bundle: "a", covers: "x", packages: new Map() }));
    expect(noticeText(bare) as string).not.toContain("Liberation");
  });

  it("names every file the manifest points at, `main`, `types`, `bin` and `exports`, without patterns", () => {
    expect(entryTargets({ main: "./a.js", types: "./a.d.ts", bin: { x: "./bin/x.mjs" }, exports: { ".": { types: "./a.d.ts", import: "./a.js" }, "./dist/*": "./dist/*", "./package.json": "./package.json" } })).toEqual(["a.d.ts", "a.js", "bin/x.mjs", "package.json"]);
  });
});

describe("release assets: the archives carry the licence texts", () => {
  // A small package and repository: a bundle with its map and its licence file, a declaration folder, a LICENSE.
  const repoRoot = mkdtempSync(join(scratch, "assets-repo-"));
  const packageRoot = join(repoRoot, "packages", "example");
  const out = join(scratch, "assets-out");
  mkdirSync(join(packageRoot, "dist", "types"), { recursive: true });
  mkdirSync(join(packageRoot, "dist", "fonts"), { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(repoRoot, "LICENSE"), "MIT licence text");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@argusvane/example", version: "1.0.0" }));
  writeFileSync(join(packageRoot, "dist", "a.js"), "export {};");
  writeFileSync(join(packageRoot, "dist", "fonts", "LICENSE"), "fonts");
  writeFileSync(join(packageRoot, "dist", "a.js.map"), "{}");
  writeFileSync(join(packageRoot, "dist", "a.d.ts"), "export {};");
  writeFileSync(join(packageRoot, "dist", "types", "t.d.ts"), "export {};");
  const packages = new Map([["lit-html@3.3.3", { name: "lit-html", version: "3.3.3", license: "BSD-3-Clause", homepage: "", texts: [{ file: "LICENSE", text: "BSD" }], scopes: new Set(["core"]) }]]);
  writeFileSync(join(packageRoot, "dist", "a.LICENSE.txt"), renderLicenceFile({ bundle: "a", covers: "x", packages }));

  const listing = (archive: string): string[] =>
    execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((name) => name.replace(/^\.\//, ""));
  const contents = (archive: string, file: string): string => execFileSync("tar", ["-xzOf", archive, file], { encoding: "utf8" });

  // The files a NOTICE names: the last part of each package line after its "): ", and each indented asset path.
  const namedBy = (notice: string): string[] =>
    notice
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .flatMap((line) => (line.includes("): ") ? line.slice(line.indexOf("): ") + 3).split(", ") : [line.trim()]));

  it("puts LICENSE, NOTICE and the bundles' licence files beside the source maps", () => {
    archiveMaps({ packageRoot, repoRoot, out, version: "1.0.0" });
    const archive = join(out, "datum-sourcemaps-1.0.0.tar.gz");
    expect(listing(archive).sort()).toEqual(["LICENSE", "NOTICE", "a.LICENSE.txt", "a.js.map"]);
    expect(contents(archive, "LICENSE")).toBe("MIT licence text");
    const notice = contents(archive, "NOTICE");
    // The archive holds the contents of dist at its root, and no font or data file: the NOTICE names a path without
    // the dist/ prefix, lists no asset licence, and every file it names is in the archive.
    expect(notice).toContain("lit-html 3.3.3 (BSD-3-Clause): a.LICENSE.txt");
    expect(notice).not.toContain("dist/");
    expect(notice).not.toContain("fonts/LICENSE");
    const named = namedBy(notice);
    expect(named).toEqual(["a.LICENSE.txt"]);
    for (const file of named) {
      expect(listing(archive), file).toContain(file);
    }
  });

  it("puts LICENSE and NOTICE at the root of the script bundles, without the declarations", () => {
    archiveBundles({ packageRoot, repoRoot, out, version: "1.0.0" });
    const archive = join(out, "datum-bundles-1.0.0.tar.gz");
    const names = listing(archive);
    for (const name of ["LICENSE", "NOTICE", "a.js", "a.LICENSE.txt"]) {
      expect(names, name).toContain(name);
    }
    expect(names.filter((name) => name.startsWith("types"))).toEqual([]);
    const notice = contents(archive, "NOTICE");
    expect(notice).toContain("@argusvane/example");
    // The font licence is in this archive, so the NOTICE names it, at the archive root.
    expect(notice).toContain("lit-html 3.3.3 (BSD-3-Clause): a.LICENSE.txt");
    expect(notice).not.toContain("dist/");
    const named = namedBy(notice);
    expect(named).toEqual(["a.LICENSE.txt", "fonts/LICENSE"]);
    for (const file of named) {
      expect(names, file).toContain(file);
    }
  });
});

describe("build-types: no private package left in a declaration", () => {
  // The declaration files tsc emitted, in a scratch folder: a specifier is rewritten only to a file that exists.
  const types = mkdtempSync(join(scratch, "types-"));
  const emitted = new Map([
    ["@argusvane/datum-engine", join(types, "engine", "form-engine", "index.d.ts")],
    ["@argusvane/datum-engine/render", join(types, "engine", "form-engine", "render", "index.d.ts")]
  ]);
  for (const file of emitted.values()) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export {};");
  }

  it("rewrites a private specifier to the relative path of the declaration emitted for it", () => {
    const text = 'import type { A } from "@argusvane/datum-engine";\nexport * from "@argusvane/datum-engine/render";\ntype T = import("@argusvane/datum-engine").B;\n';
    const { text: out, left, missing } = rewriteSpecifiers(text, join(types, "packages", "datum", "src", "form.d.ts"), emitted);
    expect(out).toContain('from "../../../engine/form-engine/index.js"');
    expect(out).toContain('export * from "../../../engine/form-engine/render/index.js"');
    expect(out).toContain('import("../../../engine/form-engine/index.js").B');
    expect(out).not.toContain("@argusvane/datum-engine");
    expect([...left, ...missing]).toEqual([]);
  });

  it("leaves relative and node specifiers, reports the bare packages that remain, and skips a doc comment's example", () => {
    const text = [
      'import { a } from "./a.js";',
      'import type { Server } from "node:http";',
      'import type { TemplateResult } from "lit-html/directives/ref.js";',
      " * import { plugins } from \"@argusvane/datum\";",
      '// export { x } from "@acme/example";',
      "/* it reads from \"the browser\" */"
    ].join("\n");
    const { text: out, left } = rewriteSpecifiers(text, join(types, "x.d.ts"), emitted);
    expect(out).toBe(text);
    expect([...left]).toEqual(["lit-html/directives/ref.js"]);
    expect(packageOf("lit-html/directives/ref.js")).toBe("lit-html");
    expect(packageOf("@codemirror/state/dist/index.js")).toBe("@codemirror/state");
  });

  it("reports a private specifier no declaration was emitted for", () => {
    const { missing } = rewriteSpecifiers('export * from "@argusvane/datum-engine";', join(types, "x.d.ts"), new Map([["@argusvane/datum-engine", join(scratch, "absent.d.ts")]]));
    expect([...missing][0]).toContain("@argusvane/datum-engine");
  });
});

// The real tarball of this package: needs a built dist (npm run build), which the CI job makes after
// its tests; `npm run pack:check` runs the same check there.
describe.skipIf(!existsSync(join(packageRoot, "dist", "datum-form.js")))("@argusvane/datum: the files npm would pack", () => {
  it("carries the bundles, the types, the licence texts and the notices, and nothing it must not", () => {
    execFileSync(process.execPath, [join(packageRoot, "..", "..", "scripts", "npm", "prepack.mjs")], { cwd: packageRoot });
    const info = dryRunPack(packageRoot) as { files: Array<{ path: string; size: number }>; size: number; unpackedSize: number };
    const paths = new Set(info.files.map((file) => file.path));
    for (const path of ["package.json", "LICENSE", "NOTICE", "README.md", "dist/datum-form.js", "dist/datum-builder.js", "dist/datum-engine.js", "dist/datum-webauthn.js", "dist/datum-webauthn.LICENSE.txt", "dist/datum-form.LICENSE.txt", "dist/datum-builder.LICENSE.txt", "dist/fonts/LICENSE", "dist/pdfjs/LICENSE", "dist/types/packages/datum/src/form.d.ts"]) {
      expect(paths.has(path), path).toBe(true);
    }
    expect(packProblems(packageRoot, info.files)).toEqual([]);
    expect([...paths].filter((path) => path.startsWith("src/") || path.startsWith("fonts/") || path.startsWith("tests/"))).toEqual([]);
    // About 11 MB packed with the PDF module's fonts and pdf.js's data: a jump past these budgets is a decision.
    expect(info.size).toBeLessThan(14 * 1024 * 1024);
    expect(info.unpackedSize).toBeLessThan(36 * 1024 * 1024);
    console.log(sizeReport("@argusvane/datum", info.files, info.size));
  }, 120_000);

  it("the manifest's exports all name built files", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(manifest.private).toBe(false);
    expect(manifest.dependencies).toBeUndefined();
    for (const target of entryTargets(manifest)) {
      expect(existsSync(join(packageRoot, target)), target).toBe(true);
    }
  });
});

describe("release pack: the folder it writes into and the INTEGRITY file", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "release-pack-"));
  const expected: string[] = [tarballName("@argusvane/datum", "0.1.0"), tarballName("datum-host-check", "0.1.0")];

  it("names tarballs as npm pack does", () => {
    expect(expected).toEqual(["argusvane-datum-0.1.0.tgz", "datum-host-check-0.1.0.tgz"]);
  });

  it("refuses a folder holding anything pack does not write, and leaves it alone", () => {
    const folder = scratch();
    writeFileSync(join(folder, "keep.txt"), "mine");
    writeFileSync(join(folder, "PUBLISH_ORDER"), "x\n");
    expect(clearPackFolder(folder, expected)[0]).toMatch(/keep\.txt/);
    expect(existsSync(join(folder, "keep.txt"))).toBe(true);
    expect(existsSync(join(folder, "PUBLISH_ORDER"))).toBe(true);
  });

  it("clears a folder an earlier or a failed run left, and creates a missing one", () => {
    const folder = scratch();
    writeFileSync(join(folder, "argusvane-datum-0.1.0.tgz"), "half");
    expect(clearPackFolder(folder, expected)).toEqual([]);
    expect(existsSync(join(folder, "argusvane-datum-0.1.0.tgz"))).toBe(false);
    const fresh = join(scratch(), "new");
    expect(clearPackFolder(fresh, expected)).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it("writes one '<integrity>  <file>' line per tarball, in order, that the publish job's awk reads back", () => {
    const text: string = integrityText(expected, ["sha512-AAA=", "sha512-BBB="]);
    expect(text).toBe("sha512-AAA=  argusvane-datum-0.1.0.tgz\nsha512-BBB=  datum-host-check-0.1.0.tgz\n");
    const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows", "release-npm.yml"), "utf8");
    expect(workflow).toContain("awk -v file=\"$file\" '$2 == file { print $1 }' INTEGRITY");
    const lookup = (file: string) => text.split("\n").map((line) => line.split(/\s+/)).find((fields) => fields[1] === file)?.[0];
    expect(lookup("datum-host-check-0.1.0.tgz")).toBe("sha512-BBB=");
  });
});
