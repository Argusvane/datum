import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/paths.js";

const run = promisify(execFile);

/**
 * The four bare command names on npm (`datum-form-test`, `datum-host-check`, `datum-security-check`,
 * `datum-binding-check`) are held by forwarding packages under packages/cli-forwarders: each one
 * depends on the exact version of the scoped package that has the tool and runs that package's command.
 * The names are held so that `npx datum-host-check` can never fetch someone else's package.
 */

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  publishConfig?: { access?: string; provenance?: boolean };
}

const manifestAt = (path: string): Manifest => JSON.parse(readFileSync(join(REPO_ROOT, path, "package.json"), "utf8")) as Manifest;

/** Each forwarder: the command it holds, and the scoped package's folder that carries it. */
const FORWARDERS = [
  { name: "datum-form-test", scoped: "packages/form-test" },
  { name: "datum-host-check", scoped: "packages/conformance-suite" },
  { name: "datum-security-check", scoped: "packages/conformance-suite" },
  { name: "datum-binding-check", scoped: "packages/conformance-suite" }
];

const scratch = mkdtempSync(join(tmpdir(), "datum-forwarders-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(FORWARDERS)("the $name forwarder", ({ name, scoped }) => {
  const folder = `packages/cli-forwarders/${name}`;
  const manifest = manifestAt(folder);
  const target = manifestAt(scoped);

  it("is a publishable package of its own name, version and provenance as the package it forwards to", () => {
    expect(manifest.name).toBe(name);
    expect(manifest.private).toBe(false);
    expect(manifest.version).toBe(target.version);
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    expect(manifest.files).toEqual(["bin", "README.md", "LICENSE", "NOTICE"]);
  });

  it("depends on exactly the scoped package that has the command, at its own version, and nothing else", () => {
    expect(target.bin[name], `${target.name} has no command ${name}`).toBeDefined();
    expect(manifest.dependencies).toEqual({ [target.name]: target.version });
    expect(manifest.bin).toEqual({ [name]: `./bin/${name}.mjs` });
  });

  it("names the same package and command in its shim, and the README shows the scoped npx form", () => {
    const shim = readFileSync(join(REPO_ROOT, folder, "bin", `${name}.mjs`), "utf8");
    expect(shim).toContain(`const SCOPED = "${target.name}";`);
    expect(shim).toContain(`const COMMAND = "${name}";`);
    expect(readFileSync(join(REPO_ROOT, folder, "README.md"), "utf8")).toContain(`npx --package ${target.name} ${name}`);
  });

  // The shim in a folder shaped like an install: the forwarder and a stand-in for the scoped package side by side.
  function install(withScoped: boolean): string {
    const app = mkdtempSync(join(scratch, "app-"));
    const bin = join(app, "node_modules", name, "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(REPO_ROOT, folder, "bin", `${name}.mjs`), join(bin, `${name}.mjs`));
    chmodSync(join(bin, `${name}.mjs`), 0o755);
    writeFileSync(join(app, "node_modules", name, "package.json"), JSON.stringify({ name, version: "0.0.0", type: "module" }));
    if (withScoped) {
      const scopedDir = join(app, "node_modules", ...target.name.split("/"));
      mkdirSync(join(scopedDir, "bin"), { recursive: true });
      writeFileSync(join(scopedDir, "package.json"), JSON.stringify({ name: target.name, version: "0.0.0", type: "module", bin: { [name]: `./bin/${name}.mjs` } }));
      writeFileSync(join(scopedDir, "bin", `${name}.mjs`), 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stderr.write("from the scoped package\\n");\nprocess.exitCode = 7;\n');
    }
    return join(bin, `${name}.mjs`);
  }

  it("runs the scoped package's command with the same arguments and exits with its code", async () => {
    const shim = install(true);
    const failed = await run(process.execPath, [shim, "--only", "MNT", "a b"]).then(() => undefined, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(failed?.code).toBe(7);
    expect(JSON.parse(failed!.stdout)).toEqual(["--only", "MNT", "a b"]);
    expect(failed?.stderr).toBe("from the scoped package\n");
  });

  it("says what to run instead, and exits 4, where the scoped package is not installed", async () => {
    const shim = install(false);
    const failed = await run(process.execPath, [shim, "--help"]).then(() => undefined, (error: { code: number; stderr: string }) => error);
    expect(failed?.code).toBe(4);
    expect(failed?.stderr).toContain(`npx --package ${target.name} ${name}`);
  });
});
