import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { describe, expect, it } from "vitest";

import { CONTROL_VALUES } from "../src/fixtures/controls.js";
import { programFromText } from "../src/runners/program/load-program.js";
import { runSuite } from "../src/run.js";
import type { VectorResult } from "../src/report/model.js";
import { vector } from "../src/vectors/helpers.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgram } from "./helpers/programs.js";

const byId = (results: VectorResult[], id: string): VectorResult => {
  const found = results.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`no result for ${id}`);
  }
  return found;
};

describe("a program built from this checkout's source", () => {
  it("passes every enforced vector of the catalogue under the release gate; pending and heavy vectors are skipped, naming why", async () => {
    const report = await runSuite({ program: builtProgram() });
    // An advisory vector that finds a known gap reports WARN (SEC-04: see tests/program-packs.test.ts); nothing else but PASS and SKIP.
    const failing = report.results.filter((result) => result.status !== "PASS" && result.status !== "SKIP" && !(result.status === "WARN" && result.gate === "advisory"));
    expect(failing.map((result) => `${result.id} ${result.status}: ${result.notes ?? ""}`)).toEqual([]);
    expect(report.verdict).toBe("PASS");
    expect(report.results.map((result) => result.id)).toEqual(VECTORS.filter((entry) => entry.applies.program !== false).map((entry) => entry.id));
    expect(byId(report.results, "ISO-04").status).toBe("PASS");
    expect(byId(report.results, "RES-19").status).toBe("PASS");
    expect(byId(report.results, "RES-10").notes).toMatch(/heavy vector/);
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    expect(report.program?.abiOk).toBe(true);
    expect(report.program?.golden).toEqual({ file: "abi-1.0.json", abi: WASM_ABI_VERSION });
    // Every enforced vector against the real program; a shared CI runner needs more than the 60 s default.
  }, 180_000);

  it("selects by id, class and prefix, and --skip removes", async () => {
    const only = await runSuite({ program: builtProgram(), only: ["CTL-01", "abi"] });
    expect(only.results.map((result) => result.id)).toEqual(["CTL-01", "ABI-01", "ABI-02", "ABI-03", "ABI-04", "ABI-05"]);
    const skipped = await runSuite({ program: builtProgram(), only: ["control"], skip: ["CTL-06"] });
    expect(skipped.results.map((result) => result.id)).toEqual(["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05"]);
  });

  it("gives each variant its own row with its own status", async () => {
    const report = await runSuite({ program: builtProgram(), only: ["ABI-04"] });
    const result = byId(report.results, "ABI-04");
    expect(result.variants?.map((variant) => variant.id)).toEqual(["number", "empty", "malformed", "null"]);
    expect(result.variants?.every((variant) => variant.status === "PASS")).toBe(true);
  });

  it("reports ABI detection against the manifest ABI and the floor", async () => {
    const matching = await runSuite({ program: builtProgram(), only: ["ABI-02"], manifestAbi: WASM_ABI_VERSION });
    expect(byId(matching.results, "ABI-02").status).toBe("PASS");
    const mismatched = await runSuite({ program: builtProgram(), only: ["ABI-02"], manifestAbi: "0.9.0" });
    expect(byId(mismatched.results, "ABI-02").status).toBe("FAIL");
    expect(byId(mismatched.results, "ABI-02").notes).toMatch(/manifest says sandboxAbi 0\.9\.0/);
    const raised = await runSuite({ program: builtProgram(), only: ["ABI-01", "ABI-02"], abiFloor: "1.2.0" });
    expect(raised.results.map((result) => result.status)).toEqual(["FAIL", "FAIL"]);
    expect(byId(raised.results, "ABI-02").notes).toMatch(/not the floor 1\.2\.0/);
  });

  it("warns, rather than fails, when the banner comment disagrees with the program's own answer", async () => {
    const lying = programFromText(`/* Datum sandbox program (ABI 0.8.0). */\n${builtProgram().text}`, "banner.js", "file");
    const report = await runSuite({ program: lying, only: ["ABI-02"] });
    expect(lying.bannerAbi).toBe("0.8.0");
    expect(byId(report.results, "ABI-02").status).toBe("WARN");
    expect(report.verdict).toBe("PASS");
    const strict = await runSuite({ program: lying, only: ["ABI-02"], failOn: "warn" });
    expect(strict.verdict).toBe("FAIL");
  });
});

describe("the runner's own rules", () => {
  const probe = vector({
    id: "CTL-90",
    title: "synthetic",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [] },
    input: { kind: "values", values: CONTROL_VALUES["CTL-01"]() },
    expect: { op: "elapsedMax", ms: 60_000 }
  });

  it("skips a heavy vector unless --heavy or the full gate asks for it", async () => {
    const heavy = { ...probe, id: "CTL-91", applies: { program: { heavy: true }, endpoint: false, parity: false } } as const;
    expect((await runSuite({ program: builtProgram(), vectors: [heavy] })).results[0]?.status).toBe("SKIP");
    expect((await runSuite({ program: builtProgram(), vectors: [heavy], heavy: true })).results[0]?.status).toBe("PASS");
    expect((await runSuite({ program: builtProgram(), vectors: [heavy], gate: "full" })).results[0]?.status).toBe("PASS");
  });

  it("fails a vector that outlives its wall-clock bound, though its answer was right", async () => {
    const slow = { ...probe, id: "CTL-92", limits: { programMs: 0.001 }, expect: { op: "accepted", value: true } } as const;
    const report = await runSuite({ program: builtProgram(), vectors: [slow] });
    expect(report.results[0]?.status).toBe("FAIL");
    expect(report.results[0]?.notes).toMatch(/over the 0\.001 ms bound/);
  });

  it("applies the gate: an advisory miss warns, a pending pass is XPASS, a pending miss XFAIL", async () => {
    const miss = { op: "accepted", value: false } as const;
    const hit = { op: "accepted", value: true } as const;
    const vectors = [
      { ...probe, id: "CTL-93", gate: { status: "advisory" }, expect: miss },
      { ...probe, id: "CTL-94", gate: { status: "pending", blockedBy: "a kernel fix" }, expect: hit },
      { ...probe, id: "CTL-95", gate: { status: "pending", blockedBy: "a kernel fix" }, expect: miss },
      { ...probe, id: "CTL-96", gate: { status: "enforced" }, expect: miss }
    ] as const;
    const report = await runSuite({ program: builtProgram(), vectors: [...vectors], gate: "full" });
    expect(report.results.map((result) => result.status)).toEqual(["WARN", "XPASS", "XFAIL", "FAIL"]);
    expect(report.verdict).toBe("FAIL");
    const lenient = await runSuite({ program: builtProgram(), vectors: vectors.slice(0, 3) as never, gate: "full" });
    expect(lenient.verdict).toBe("PASS");
    const strict = await runSuite({ program: builtProgram(), vectors: vectors.slice(0, 3) as never, gate: "full", failOn: "warn" });
    expect(strict.verdict).toBe("FAIL");
  });

  it("marks every vector ERROR when the program will not start, and reports INCONCLUSIVE for the enforced ones", async () => {
    const broken = programFromText("this is ( not javascript", "broken.js", "file");
    const report = await runSuite({ program: broken, only: ["CTL-01"] });
    expect(report.results[0]?.status).toBe("ERROR");
    expect(report.program?.startupError).toMatch(/SyntaxError|compile/i);
    expect(report.verdict).toBe("INCONCLUSIVE");
    // The ABI vectors still report: they are the check that says "this is not a sandbox program".
    const abi = await runSuite({ program: broken, only: ["ABI-01", "ABI-02"] });
    expect(abi.results.map((result) => result.status)).toEqual(["FAIL", "FAIL"]);
    expect(abi.verdict).toBe("FAIL");
  });

  it("reports a program that answers no inspect request", async () => {
    const mute = programFromText('globalThis.__datum_run = function () { return \'{"errors":[]}\'; };', "mute.js", "file");
    const report = await runSuite({ program: mute, only: ["ABI-02"] });
    expect(report.results[0]?.status).toBe("FAIL");
    expect(report.results[0]?.notes).toMatch(/does not answer __datum_inspect/);
  });
});
