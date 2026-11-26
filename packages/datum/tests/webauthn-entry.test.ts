// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `datum-webauthn.js` (src/webauthn.ts): the WebAuthn functions with no element. Built here with the
 * package's own settings (`--mode webauthn`) into a temp folder, then imported by a plain `node`
 * child with no jsdom and no DOM globals: what a server or a worker does.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let out: string;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "datum-webauthn-entry-"));
  execFileSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--mode", "webauthn", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
    cwd: root,
    env: { ...process.env, DATUM_BUNDLE_FORMAT: "es" },
    stdio: "pipe"
  });
}, 120_000);

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

function runInNode(script: string): string {
  const entry = pathToFileURL(join(out, "datum-webauthn.js")).href;
  return execFileSync(process.execPath, ["--input-type=module", "-e", `const ENTRY = ${JSON.stringify(entry)};\n${script}`], { encoding: "utf8", stdio: "pipe" });
}

describe("datum-webauthn.js", () => {
  it("is one file with no chunk, and names no DOM global", () => {
    expect(readdirSync(out).filter((name) => name.endsWith(".js"))).toEqual(["datum-webauthn.js"]);
    const text = readFileSync(join(out, "datum-webauthn.js"), "utf8");
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/^\s*import\s/m);
    for (const global of ["document", "window", "customElements", "HTMLElement"]) {
      expect(text, global).not.toMatch(new RegExp(`(?<![A-Za-z0-9_$."'])${global}(?![A-Za-z0-9_$"':])`));
    }
  });

  it("imports in plain Node and exports the real functions", () => {
    const output = runInNode(`
      for (const name of ["window", "document", "customElements", "HTMLElement"]) {
        if (name in globalThis) throw new Error(name + " is defined in this node");
      }
      const mod = await import(ENTRY);
      const names = ["createWebAuthnSigningProvider", "verifyWebAuthnSubmission", "verifyAssertion", "verifyRegistration", "registerCredential", "requestAssertion", "WebAuthnError"];
      console.log(JSON.stringify(names.map((name) => [name, typeof mod[name]])));
      const error = new mod.WebAuthnError("not-supported", "x");
      console.log(error instanceof Error, error.code);
    `);
    const [list, instance] = output.trim().split("\n");
    expect(JSON.parse(list ?? "[]")).toEqual([
      ["createWebAuthnSigningProvider", "function"],
      ["verifyWebAuthnSubmission", "function"],
      ["verifyAssertion", "function"],
      ["verifyRegistration", "function"],
      ["registerCredential", "function"],
      ["requestAssertion", "function"],
      ["WebAuthnError", "function"]
    ]);
    expect(instance).toMatch(/^true /);
  });
});
