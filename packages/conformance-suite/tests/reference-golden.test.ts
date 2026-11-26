import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formulaFunctionSignatures, kernelDocumentDigest, kernelSha256Hex, kernelStableStringify, kernelUtf8Binary, runKernel } from "@argusvane/datum-engine";
import { describe, expect, it } from "vitest";

import { BUNDLED_GOLDEN, BUNDLED_GOLDEN_ABI, chooseGolden, GOLDEN_DOCUMENT_INPUTS, goldenCaseContext, type GoldenFile } from "../src/fixtures/golden.js";
import { canonicalText, referenceDigest, sha256Hex } from "../src/reference/canonical.js";
import { ProgramSession } from "../src/runners/program/session.js";
import { builtProgramText } from "./helpers/programs.js";
import { REPO_ROOT, PACKAGE_ROOT } from "./helpers/paths.js";

const golden = BUNDLED_GOLDEN;

interface SharedCase {
  name: string;
  input: string;
  engine: string;
  codeUnit: string;
  divergent: boolean;
}
const sharedCases = JSON.parse(readFileSync(join(REPO_ROOT, "integrations/shared/fixtures/canonical.json"), "utf8")) as SharedCase[];

describe("the independent reference serializer", () => {
  it("writes the canonical form the shared fixtures pin, for every case", () => {
    expect(sharedCases.length).toBeGreaterThanOrEqual(11);
    for (const fixture of sharedCases) {
      expect(canonicalText(JSON.parse(fixture.input)), fixture.name).toBe(fixture.engine);
    }
    expect(sharedCases.some((fixture) => fixture.divergent)).toBe(false);
  });

  it("agrees with the kernel's own serializer and SHA-256 on the same cases", () => {
    for (const fixture of sharedCases) {
      const parsed = JSON.parse(fixture.input) as unknown;
      const kernel = kernelDocumentDigest(parsed);
      const reference = referenceDigest(parsed);
      expect(reference.canonical, fixture.name).toBe(kernel.canonical);
      expect(reference.digest, fixture.name).toBe(kernel.digest);
    }
  });

  it("hashes UTF-8 with node:crypto, matching the kernel's pure-JS SHA-256 on known inputs", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const text of ["x".repeat(1000), "café 你好 🙂", '{"a":1}']) {
      expect(sha256Hex(text)).toBe(kernelSha256Hex(kernelUtf8Binary(text)));
    }
  });

  it("puts array-index keys first and ascending, then the rest by UTF-16 code unit", () => {
    expect(canonicalText(JSON.parse('{"b":1,"10":1,"a":1,"2":1,"01":1,"B":1}'))).toBe('{"2":1,"10":1,"01":1,"B":1,"a":1,"b":1}');
    expect(canonicalText({ z: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });
});

describe("golden/abi-4.1.json", () => {
  it("carries the ABI it was generated for, the sandbox ABI, and is the file for a program of that major.minor", async () => {
    const { WASM_ABI_VERSION } = await import("@argusvane/datum-engine");
    expect(golden.abi).toBe(WASM_ABI_VERSION);
    expect(BUNDLED_GOLDEN_ABI).toBe(WASM_ABI_VERSION.split(".").slice(0, 2).join("."));
    expect(chooseGolden(WASM_ABI_VERSION)).toEqual({ golden, file: BUNDLED_GOLDEN_ABI });
  });

  it("judges a program of another ABI, or of an unknown one, against the same file with a warning", () => {
    expect(chooseGolden("3.0.0")).toMatchObject({ golden, file: BUNDLED_GOLDEN_ABI, warning: expect.stringMatching(/answers ABI 3\.0\.0/) });
    expect(chooseGolden("4.2.0").warning).toMatch(/answers ABI 4\.2\.0/);
    expect(chooseGolden(undefined).warning).toMatch(/unknown/);
  });

  it("holds canonical text and digests the independent reference reproduces from the stored input", () => {
    const own = GOLDEN_DOCUMENT_INPUTS.map((document) => document.name);
    expect(golden.documents.map((document) => document.name)).toEqual([...own, ...sharedCases.map((fixture) => `shared: ${fixture.name}`)]);
    for (const document of golden.documents) {
      const reference = referenceDigest(JSON.parse(document.input));
      expect(document.canonical, document.name).toBe(reference.canonical);
      expect(document.digest, document.name).toBe(reference.digest);
      expect(document.digest, document.name).toBe(sha256Hex(document.canonical));
    }
  });

  it("carries the shared fixtures' cases verbatim, so a program is held to the bytes every host port is held to", () => {
    for (const fixture of sharedCases) {
      const stored = golden.documents.find((document) => document.name === `shared: ${fixture.name}`);
      expect(stored?.input, fixture.name).toBe(fixture.input);
      expect(stored?.canonical, fixture.name).toBe(fixture.engine);
    }
  });

  it("pins the outcome bytes of the golden case over the wire-serialized context, and the program reproduces them", async () => {
    const session = await ProgramSession.open({ program: builtProgramText() });
    try {
      const wire = session.serialize(goldenCaseContext());
      const run = await session.run(wire);
      expect(run.text?.length).toBe(golden.goldenCase.canonicalLength);
      expect(sha256Hex(run.text ?? "")).toBe(golden.goldenCase.canonicalSha256);
      // The in-process kernel over the same wire text gives the same bytes: the golden file is the kernel's, not a lucky program's.
      const inProcess = kernelStableStringify(runKernel(JSON.parse(wire) as never, [], undefined, formulaFunctionSignatures()));
      expect(sha256Hex(inProcess)).toBe(golden.goldenCase.canonicalSha256);
    } finally {
      session.dispose();
    }
  });

  it("is what scripts/write-golden.ts writes (the file on disk parses and has every control)", () => {
    const onDisk = JSON.parse(readFileSync(join(PACKAGE_ROOT, "golden", "abi-4.1.json"), "utf8")) as GoldenFile;
    expect(Object.keys(onDisk.controls).sort()).toEqual(["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06"]);
    expect(onDisk.controls["CTL-01"]?.accepted).toBe(true);
    expect(onDisk.controls["CTL-02"]).toEqual({ accepted: false, errors: ["required@name"] });
  });
});
