// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { ALLOWED_LICENCES, EXCEPTIONS, licenceProblem } from "../scripts/licence-policy.mjs";
// @ts-expect-error plain .mjs script without typings
import { collectPackages, packageProblems, parseLicenceFile } from "../scripts/notices-lib.mjs";

/*
 * The licence allow-list (scripts/licence-policy.mjs): a third-party package that reaches a bundle under a copyleft or an unknown
 * licence fails the notice step with the package's name, and the licences the bundles carry today all pass.
 */
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("licenceProblem", () => {
  it("allows the permissive identifiers and the expressions built from them", () => {
    for (const licence of [...ALLOWED_LICENCES, "(MIT OR Apache-2.0)", "Apache-2.0 AND MIT", "Apache-2.0 OR BSD-3-Clause", "(BSD-2-Clause AND (ISC OR MIT))", "Apache-2.0 WITH LLVM-exception"]) {
      expect(licenceProblem("some-package", licence), licence).toBeNull();
    }
  });

  it("fails a copyleft, a non-commercial and an unknown licence with the package's name and version", () => {
    for (const licence of ["GPL-3.0", "GPL-2.0-or-later", "AGPL-3.0-only", "LGPL-2.1", "SSPL-1.0", "CC-BY-NC-4.0", "MPL-2.0", "SEE LICENSE IN LICENSE", "Custom"]) {
      const problem = licenceProblem("left-pad-gpl", licence, "1.2.3");
      expect(problem, licence).toContain("left-pad-gpl 1.2.3");
      expect(problem, licence).toContain(`"${licence}"`);
    }
    expect(licenceProblem("no-licence", "UNKNOWN", "1.0.0")).toBe("no-licence 1.0.0 declares no licence");
    expect(licenceProblem("empty", "")).toBe("empty declares no licence");
  });

  it("fails an expression when an AND part is not allowed, and accepts an OR when one alternative is", () => {
    expect(licenceProblem("a", "MIT AND GPL-3.0")).not.toBeNull();
    expect(licenceProblem("a", "GPL-3.0 OR MIT")).toBeNull();
    expect(licenceProblem("a", "GPL-3.0 OR AGPL-3.0")).not.toBeNull();
    expect(licenceProblem("a", "MIT WITH Classpath-exception-2.0")).not.toBeNull();
    expect(licenceProblem("a", "(MIT")).not.toBeNull();
    expect(licenceProblem("a", "MIT AND")).not.toBeNull();
  });

  it("lets a listed exception through only for its own package and its exact licence", () => {
    expect(licenceProblem("@fortawesome/free-solid-svg-icons", "(CC-BY-4.0 AND MIT)", "7.3.1")).toBeNull();
    expect(licenceProblem("some-icons", "(CC-BY-4.0 AND MIT)")).not.toBeNull();
    expect(licenceProblem("certifi", "MPL-2.0")).toBeNull();
    expect(licenceProblem("another-mpl-package", "MPL-2.0")).not.toBeNull();
    expect(licenceProblem("certifi", "GPL-3.0")).not.toBeNull();
    expect(licenceProblem("pdf.js standard fonts (Liberation Sans, four unmodified TrueType faces), bundled data of pdf.js 6.5.438", "GPL-2.0-only with the Liberation font exception (Red Hat's licence text)")).toBeNull();
    expect(licenceProblem("pdf.js standard fonts (Liberation Sans, four unmodified TrueType faces), bundled data of pdf.js 6.5.438 and a GPL tool", "GPL-2.0-only with the Liberation font exception (Red Hat's licence text)")).not.toBeNull();
    expect(licenceProblem("some-gpl-font", "GPL-2.0-only with the Liberation font exception")).not.toBeNull();
  });

  it("gives every exception a reason", () => {
    for (const entry of EXCEPTIONS) {
      expect(entry.reason.length, String(entry.name)).toBeGreaterThan(20);
    }
  });
});

describe("a bundle that carries a package under a copyleft licence", () => {
  it("fails the notice step, naming the package", () => {
    const root = mkdtempSync(join(tmpdir(), "licence-policy-"));
    const lock: Record<string, { version: string }> = {};
    for (const [name, license] of Object.entries({ "fine-lib": "MIT", "copyleft-lib": "AGPL-3.0-only" })) {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", license }));
      writeFileSync(join(dir, "LICENSE"), "licence text");
      lock[`node_modules/${name}`] = { version: "1.0.0" };
    }
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: lock }));
    const problems: string[] = packageProblems(
      collectPackages([
        { file: join(root, "node_modules", "fine-lib", "a.js"), scope: "core" },
        { file: join(root, "node_modules", "copyleft-lib", "a.js"), scope: "core" }
      ])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("copyleft-lib 1.0.0");
    expect(problems[0]).toContain("AGPL-3.0-only");
  });
});

describe("the bundles built today", () => {
  const distLicenceFiles = [PKG, join(PKG, "..", "form-test"), join(PKG, "..", "conformance-suite"), join(PKG, "..", "pdf-kernel"), join(PKG, "..", "..", "plugins", "icons-fontawesome")]
    .map((folder) => join(folder, "dist"))
    .filter((dist) => existsSync(dist))
    .flatMap((dist) => readdirSync(dist).filter((name) => name.endsWith(".LICENSE.txt")).map((name) => join(dist, name)));

  it.skipIf(distLicenceFiles.length === 0)("carry only packages on the allow-list", () => {
    const problems = distLicenceFiles.flatMap((file) => parseLicenceFile(readFileSync(file, "utf8")).flatMap((pkg: { name: string; version: string; license: string }) => licenceProblem(pkg.name, pkg.license, pkg.version) ?? []));
    expect(problems).toEqual([]);
  });
});
