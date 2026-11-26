import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { describe, expect, it } from "vitest";

import { programFromText } from "../src/runners/program/load-program.js";
import { REPO_ROOT } from "./helpers/paths.js";

const WRITER = join(REPO_ROOT, "packages", "datum", "scripts", "write-sandbox-program.ts");
const BUILT = join(REPO_ROOT, "packages", "datum", "dist", "datum-sandbox-program.js");

/**
 * The shipped program's banner comment names the ABI it was built for, and the suite's loader reads
 * that name back (`bannerAbi`) as a hint for its report. The writer (packages/datum
 * scripts/write-sandbox-program.ts) and the reader (the loader's BANNER pattern) are two
 * separate pieces of text, so this holds them together: when the banner's wording changes on one
 * side, the loader stops finding the number and this test names it.
 */
describe("the banner of the sandbox program", () => {
  // The writer's first banner line is a template literal over WASM_ABI_VERSION. Reading it from the
  // source and filling the number in needs no build, so a change of wording fails in every run.
  it("the writer's template names the engine's ABI version, in the form the loader reads", () => {
    const source = readFileSync(WRITER, "utf8");
    const template = /`(\/\* Datum sandbox program[^`]*)`/.exec(source)?.[1];
    expect(template, "write-sandbox-program.ts has no banner template line").toBeDefined();
    expect(template).toContain("${WASM_ABI_VERSION}");
    const line = template!.replaceAll("${WASM_ABI_VERSION}", WASM_ABI_VERSION);
    const program = programFromText(`${line}\n`, WRITER, "built");
    expect(program.bannerAbi).toBe(WASM_ABI_VERSION);
  });

  // The built file is the second witness; only a missing dist skips it, and the title says so as
  // vitest prints no skip reason.
  const built = existsSync(BUILT);
  const title = built
    ? "the built file names the engine's ABI version, in the form the loader reads"
    : "the built file names the engine's ABI version, in the form the loader reads (skipped: packages/datum/dist/datum-sandbox-program.js is not built; run npm run build in packages/datum)";

  it.skipIf(!built)(title, () => {
    const program = programFromText(readFileSync(BUILT, "utf8"), BUILT, "built");
    expect(program.bannerAbi).toBe(WASM_ABI_VERSION);
  });
});
