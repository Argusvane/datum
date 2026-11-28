import { describe, expect, it } from "vitest";

import { programFromText } from "../src/runners/program/load-program.js";
import type { Report } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { noHardeningProgramText, staleAbiProgramText, yesManProgramText } from "./helpers/programs.js";

/**
 * Negative programs: the suite is only worth anything if a broken program fails it. Each one is the
 * real program with one thing wrong, so the failure it causes is the failure it should cause.
 */
const statusOf = (report: Report, id: string): string => report.results.find((result) => result.id === id)?.status ?? "missing";

describe("a yes-man program (__datum_run answers { errors: [] } to everything)", () => {
  it("fails the controls that expect a refusal, the golden values, and the plugin probes", async () => {
    const report = await runSuite({ program: programFromText(yesManProgramText(), "yes-man.js", "file"), gate: "full" });
    for (const id of ["CTL-02", "CTL-03", "CTL-04"]) {
      expect(statusOf(report, id), id).toBe("FAIL");
    }
    // It accepts the valid submission, but nothing is sanitized: the golden values are missing.
    expect(statusOf(report, "CTL-01")).toBe("FAIL");
    expect(statusOf(report, "CTL-05")).toBe("FAIL");
    expect(statusOf(report, "CTL-06")).toBe("FAIL");
    expect(statusOf(report, "ISO-01")).toBe("FAIL");
    expect(report.verdict).toBe("FAIL");
    // It still answers inspect (the real one), so the ABI vectors do not mistake it for broken.
    expect(statusOf(report, "ABI-02")).toBe("PASS");
    // The whole catalogue against a program: a shared CI runner needs more than the 60 s default.
  }, 180_000);
});

describe("a program whose ABI text says 0.9.0", () => {
  it("fails ABI-01 and ABI-02, names the version it answers, and is judged against the golden file with a warning", async () => {
    const report = await runSuite({ program: programFromText(staleAbiProgramText(), "stale.js", "file"), only: ["ABI"] });
    expect(statusOf(report, "ABI-01")).toBe("FAIL");
    expect(statusOf(report, "ABI-02")).toBe("FAIL");
    expect(report.results.find((result) => result.id === "ABI-02")?.notes).toMatch(/answers ABI 0\.9\.0, not the floor 1\.0\.0/);
    expect(report.program?.detectedAbi).toBe("0.9.0");
    expect(report.program?.abiOk).toBe(false);
    expect(report.program?.golden?.note).toMatch(/answers ABI 0\.9\.0/);
    expect(report.verdict).toBe("FAIL");
  });
});

describe("a program missing its Math / Date hardening", () => {
  it("fails ISO-03 (the clock and randomness are reachable) and nothing it should not", async () => {
    const report = await runSuite({ program: programFromText(noHardeningProgramText(), "no-hardening.js", "file"), only: ["ISO-03", "CTL"] });
    expect(statusOf(report, "ISO-03")).toBe("FAIL");
    const variants = report.results.find((result) => result.id === "ISO-03")?.variants ?? [];
    expect(variants.map((variant) => variant.status)).toEqual(["PASS", "PASS"]);
    expect(report.results.filter((result) => result.id.startsWith("CTL")).every((result) => result.status === "PASS")).toBe(true);
    expect(report.verdict).toBe("FAIL");
  });
});
