import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { integrityManifest, sri, writeIntegrityManifest } from "../scripts/integrity-manifest.mjs";
import { IntegrityError, importWithIntegrity, integrityProblem, parseIntegrity } from "../src/integrity.js";
import { loadWasmValidationHost } from "../src/wasm-loader.js";

/**
 * The package's integrity manifest (dist/integrity.json, the last build step) lists the sha384 of
 * every file a page may load; `wasm-integrity` holds the sandbox module to a hash: its bytes are
 * fetched and checked, and only bytes that match are imported.
 */

const sha = (algorithm: string, text: string): string => `${algorithm}-${createHash(algorithm).update(text).digest("base64")}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the integrity manifest", () => {
  it("lists the sha384 of each file a page loads, by its path in dist, and leaves maps and declarations out", () => {
    const dist = mkdtempSync(join(tmpdir(), "integrity-manifest-"));
    writeFileSync(join(dist, "datum-form.js"), "export{};");
    writeFileSync(join(dist, "datum-form.js.map"), "{}");
    writeFileSync(join(dist, "datum-form.css"), ".a{}");
    mkdirSync(join(dist, "fonts"));
    writeFileSync(join(dist, "fonts", "Face.woff2"), "font");
    mkdirSync(join(dist, "types"));
    writeFileSync(join(dist, "types", "index.d.ts"), "export {};");
    expect(writeIntegrityManifest(dist)).toBe(3);
    const written = JSON.parse(readFileSync(join(dist, "integrity.json"), "utf8")) as { algorithm: string; files: Record<string, string> };
    expect(written).toEqual({
      algorithm: "sha384",
      files: { "datum-form.css": sha("sha384", ".a{}"), "datum-form.js": sha("sha384", "export{};"), "fonts/Face.woff2": sha("sha384", "font") }
    });
    // Written again, it does not list itself.
    expect(integrityManifest(dist)).toEqual(written);
    expect(sri(Buffer.from("x"))).toBe(sha("sha384", "x"));
  });
});

describe("Subresource Integrity for the sandbox module", () => {
  const bytes = new TextEncoder().encode("export const x = 1;");
  const text = "export const x = 1;";

  it("compares the strongest algorithm the text names, any of its digests", async () => {
    expect(parseIntegrity(`${sha("sha256", "a")} ${sha("sha512", "b")} ${sha("sha512", "c")}`)).toEqual({ algorithm: "sha512", digests: [sha("sha512", "b").slice(7), sha("sha512", "c").slice(7)] });
    expect(await integrityProblem(bytes, sha("sha384", text), "m")).toBeUndefined();
    expect(await integrityProblem(bytes, `${sha("sha384", "other")} ${sha("sha384", text)}`, "m")).toBeUndefined();
    expect(await integrityProblem(bytes, `${sha("sha256", text)} ${sha("sha512", "other")}`, "m")).toMatch(/sha512 digest is/);
    expect(await integrityProblem(bytes, "md5-abc", "m")).toMatch(/names no sha256, sha384 or sha512 digest/);
  });

  it("refuses a module whose bytes do not match, before importing anything", async () => {
    const fetched = vi.fn(async () => new Response(text, { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    await expect(importWithIntegrity("https://cdn.example/datum-wasm.js", sha("sha384", "something else"), "The module")).rejects.toThrow(IntegrityError);
    expect(fetched).toHaveBeenCalledWith("https://cdn.example/datum-wasm.js", { credentials: "same-origin" });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("refuses the sandbox for a wasm-integrity its module does not match, and says why", async () => {
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200 }));
    await expect(loadWasmValidationHost("https://cdn.example/datum-wasm-a.js", [], { integrity: sha("sha384", "not this") })).rejects.toThrow(/sha384 digest is .* which the integrity it was given does not list/);
  });

  it("imports exactly the bytes it checked, from a blob: URL", async () => {
    vi.stubGlobal("fetch", async () => new Response(text, { status: 200 }));
    const made: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      made.push(blob as Blob);
      // The test runner cannot import a blob: URL; a data: URL of the same bytes stands in.
      return `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const module = await importWithIntegrity<{ x: number }>("https://cdn.example/datum-wasm.js", sha("sha384", text), "The module");
    expect(module.x).toBe(1);
    expect(made).toHaveLength(1);
    expect(Array.from(new Uint8Array(await made[0]!.arrayBuffer()))).toEqual(Array.from(bytes));
  });
});
