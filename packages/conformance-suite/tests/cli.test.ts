import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "./helpers/paths.js";
import { beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";

import { parseArgs, UsageError } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import type { Report } from "../src/report/model.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import { VECTORS } from "../src/vectors/index.js";
import { startReferenceServer } from "./helpers/reference-submissions-server.js";
import { builtProgram, builtProgramText, noHardeningProgramText, staleAbiProgramText, yesManProgramText } from "./helpers/programs.js";
import { PDF_PROGRAM_PATH } from "./helpers/pdf-programs.js";
import { PACKAGE_ROOT } from "./helpers/paths.js";

function capture() {
  let out = "";
  let err = "";
  return { io: { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) }, out: () => out, err: () => err };
}

const work = mkdtempSync(join(tmpdir(), "datum-security-suite-"));
const file = (name: string, text: string): string => {
  const path = join(work, name);
  writeFileSync(path, text);
  return path;
};

describe("argument parsing", () => {
  it("reads values, repeated flags, equals spellings and lists", () => {
    const options = parseArgs(["--program", "p.js", "--only", "CTL-01,ISO", "--skip=abi", "--plugins", "a.js", "--plugins", "b.js", "--format", "json,md", "--gate", "full", "--fail-on", "warn", "--heavy", "--quiet", "--abi-floor", "4.1.0", "--budget-profile", "browser"]);
    expect(options).toMatchObject({ program: "p.js", only: ["CTL-01", "ISO"], skip: ["abi"], plugins: ["a.js", "b.js"], formats: ["json", "md"], gate: "full", failOn: "warn", heavy: true, quiet: true, abiFloor: "4.1.0", budgetProfile: "browser" });
  });

  it("refuses what it does not understand", () => {
    for (const argv of [["--nope"], ["--program"], ["--abi-floor", "4.0"], ["--abi-floor", "3.18.0"], ["--abi-floor", "5.0.0"], ["--budget-profile", "gpu"], ["--gate", "x"], ["--fail-on", "x"], ["--format", "pdf"], ["stray"], ["--heavy=1"], ["explain"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });

  it("knows the subcommands and the help and version flags", () => {
    expect(parseArgs(["list", "--json"])).toMatchObject({ command: "list", json: true });
    expect(parseArgs(["explain", "ISO-03"])).toMatchObject({ command: "explain", target: "ISO-03" });
    expect(parseArgs(["fixture", "--format", "submissions"])).toMatchObject({ command: "fixture", fixtureFormat: "submissions" });
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["--version"]).command).toBe("version");
  });
});

describe("the command line in process", () => {
  it("prints help and the version and exits 0", async () => {
    const help = capture();
    expect(await runCli(["--help"], help.io)).toBe(EXIT.pass);
    expect(help.out()).toContain("Exit codes");
    const version = capture();
    expect(await runCli(["--version"], version.io)).toBe(EXIT.pass);
    expect(version.out()).toMatch(/^@argusvane\/datum-conformance-suite 0\.1\.0 \(vector set /);
  });

  it("lists the catalogue as text and as JSON", async () => {
    const text = capture();
    expect(await runCli(["list"], text.io)).toBe(EXIT.pass);
    for (const vector of VECTORS) {
      expect(text.out()).toContain(vector.id);
    }
    const json = capture();
    expect(await runCli(["list", "--json"], json.io)).toBe(EXIT.pass);
    const parsed = JSON.parse(json.out()) as { suite: { vectorCount: number }; vectors: { id: string; expected: string; provenance: unknown }[] };
    expect(parsed.suite.vectorCount).toBe(VECTORS.length);
    expect(parsed.vectors.map((vector) => vector.id)).toEqual(VECTORS.map((vector) => vector.id));
    expect(parsed.vectors.every((vector) => vector.expected !== "")).toBe(true);
  });

  it("explains a vector, and exits 2 for one that does not exist", async () => {
    const known = capture();
    expect(await runCli(["explain", "par-06"], known.io)).toBe(EXIT.pass);
    expect(known.out()).toContain("pending, blocked by the endpoint parity runner");
    expect(known.out()).toContain("expects:");
    const unknown = capture();
    expect(await runCli(["explain", "ZZZ-99"], unknown.io)).toBe(EXIT.usage);
    expect(unknown.err()).toContain("no vector ZZZ-99");
  });

  it("prints the fixture form", async () => {
    const out = capture();
    expect(await runCli(["fixture"], out.io)).toBe(EXIT.pass);
    const form = JSON.parse(out.out()) as { id: string; root: { configuration: { securitySuiteFixture: string } } };
    expect(form.id).toBe("datum-security-suite");
    expect(form.root.configuration.securitySuiteFixture).toBe("1");
    const registration = capture();
    expect(await runCli(["fixture", "--format", "submissions", "--form", "my_fixture", "--form-version", "3"], registration.io)).toBe(EXIT.pass);
    const body = JSON.parse(registration.out()) as { definition: { id: string; version: string }; settings: object };
    expect(body.definition).toMatchObject({ id: "my_fixture", version: "3" });
    expect(body.settings).toEqual({});
    const renamed = capture();
    expect(await runCli(["fixture", "--form", "datum_security_suite"], renamed.io)).toBe(EXIT.pass);
    expect(JSON.parse(renamed.out())).toMatchObject({ id: "datum_security_suite", version: "1" });
  });

  it("exits 2 for usage errors: no program, unreadable program, empty program, bad flags, unknown selectors, bad manifest, an endpoint without a form or with a bad URL", async () => {
    const cases: string[][] = [
      [],
      ["--program", join(work, "missing.js")],
      ["--program", file("empty.js", "   ")],
      ["--bogus"],
      ["--program", file("p.js", builtProgramText()), "--only", "nope"],
      ["--program", file("p2.js", builtProgramText()), "--manifest", join(work, "no-manifest.json")],
      ["--program", file("p3.js", builtProgramText()), "--manifest", file("bad-manifest.json", "{}")],
      ["--program", file("p4.js", builtProgramText()), "--golden", file("bad-golden.json", "{}")],
      ["--endpoint", "http://localhost:8080"],
      ["--endpoint", "ftp://example.org", "--form", "x"],
      ["--endpoint", "http://user:pw@example.org", "--form", "x"],
      ["--form", "x"],
      ["--parity"],
      ["--program", file("p5.js", builtProgramText()), "--allow-writes"]
    ];
    for (const argv of cases) {
      const run = capture();
      expect(await runCli(argv, run.io), argv.join(" ")).toBe(EXIT.usage);
      expect(run.err(), argv.join(" ")).toMatch(/^datum-security-check: /);
    }
  });

  it("exits 4 on an internal error and says so", async () => {
    const run = capture();
    const code = await runCli([], run.io, { builtProgram: () => { throw new Error("boom"); } });
    expect(code).toBe(EXIT.internal);
    expect(run.err()).toContain("internal error: Error: boom");
  });

  it("uses the program a checkout script hands it when --program is absent", async () => {
    const run = capture();
    expect(await runCli(["--only", "ABI-01", "--quiet"], run.io, { builtProgram })).toBe(EXIT.pass);
    expect(run.out()).toBe("");
  });

  it("reads the manifest, golden file and plugin module it is given", async () => {
    const manifest = file("manifest-ok.json", JSON.stringify({ sandboxAbi: WASM_ABI_VERSION }));
    const plugin = file("plugin.js", '({ validators: [ function () { return { errors: [] }; } ] })');
    const out = join(work, "report-dir");
    const run = capture();
    const code = await runCli(["--program", file("good.js", builtProgramText()), "--manifest", manifest, "--plugins", plugin, "--only", "ABI-02,CTL-01", "--format", "json,md", "--out", out], run.io);
    expect(code).toBe(EXIT.pass);
    expect(run.out()).toMatch(/^PASS: 2 pass, 0 fail/);
    expect(existsSync(join(out, "report.json"))).toBe(true);
    expect(existsSync(join(out, "report.md"))).toBe(true);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
    expect(report.program?.manifestAbi).toBe(WASM_ABI_VERSION);
    expect(report.run.argv).toContain("--plugins");
  });

  it("exits 1 for a yes-man, a stale program and a program without hardening, and 3 for one that will not start", async () => {
    const outcomes: [string, string[], number][] = [
      ["yes-man", ["--program", file("yes.js", yesManProgramText()), "--only", "CTL", "--quiet"], EXIT.fail],
      ["stale", ["--program", file("stale.js", staleAbiProgramText()), "--only", "ABI", "--quiet"], EXIT.fail],
      ["no hardening", ["--program", file("bare.js", noHardeningProgramText()), "--only", "ISO-03", "--quiet"], EXIT.fail],
      ["broken, one enforced vector", ["--program", file("broken.js", "syntax ("), "--only", "CTL-01", "--quiet"], EXIT.inconclusive]
    ];
    for (const [name, argv, expected] of outcomes) {
      expect(await runCli(argv, capture().io), name).toBe(expected);
    }
  });

  it("honours --fail-on warn, --out - and --format", async () => {
    const lying = file("lying.js", `/* Datum sandbox program (ABI 2.9.0). */\n${builtProgramText()}`);
    expect(await runCli(["--program", lying, "--only", "ABI-02", "--quiet"], capture().io)).toBe(EXIT.pass);
    expect(await runCli(["--program", lying, "--only", "ABI-02", "--quiet", "--fail-on", "warn"], capture().io)).toBe(EXIT.fail);
    const json = capture();
    await runCli(["--program", file("g.js", builtProgramText()), "--only", "CTL-02", "--format", "json", "--out", "-"], json.io);
    expect((JSON.parse(json.out()) as Report).results[0]?.id).toBe("CTL-02");
    const md = capture();
    await runCli(["--program", file("g2.js", builtProgramText()), "--only", "CTL-02", "--out", "-"], md.io);
    expect(md.out()).toMatch(/^# Datum security check: PASS/);
  });
});

describe("the built bundle, spawned", () => {
  const bin = join(PACKAGE_ROOT, "bin", "datum-security-check.mjs");
  let program: string;

  beforeAll(() => {
    // The bundle is a build product; build it here so `npm test` does not depend on the order of the npm scripts.
    execFileSync(process.execPath, [join(PACKAGE_ROOT, "scripts", "build-cli.mjs")], { cwd: PACKAGE_ROOT, stdio: "pipe" });
    program = file("bundled-target.js", builtProgramText());
  });

  // The whole catalogue takes about a minute on a quiet machine and several times that when the root
  // gate runs every package's tests at once, so the spawn is killed only well past that; a test's own
  // timeout is longer than the spawn's.
  const SPAWN_MS = 300_000;
  const TEST_MS = 360_000;
  const spawn = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: SPAWN_MS });

  it("runs in plain Node with no TypeScript toolchain and exits 0 with a schema-valid JSON report", () => {
    // The release gate: the full gate adds the multi-second heavy and pending vectors, and a synchronous spawn that long starves vitest's worker heartbeat on a loaded machine.
    const run = spawn(["--program", program, "--format", "json", "--out", "-"]);
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as Report;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(REPORT_SCHEMA);
    expect(validate(report)).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report.summary.fail).toBe(0);
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    expect(report.results.length).toBe(VECTORS.filter((entry) => entry.applies.program !== false).length);
  }, TEST_MS);

  it("never fails the worker-host row from the bundle: PASS where the repository's host loads, otherwise SKIP with the reason", () => {
    const run = spawn(["--program", program, "--only", "RES-19", "--format", "json", "--out", "-"]);
    expect(run.status).toBe(0);
    const row = (JSON.parse(run.stdout) as Report).results.find((result) => result.id === "RES-19");
    expect(["PASS", "SKIP"]).toContain(row?.status);
    if (row?.status === "SKIP") {
      expect(row.notes).toMatch(/worker host/);
    }
  });

  it("checks the program files this repository ships, when they are built", () => {
    for (const path of ["packages/datum/dist/datum-sandbox-program.js"]) {
      if (!existsSync(join(REPO_ROOT, path))) {
        continue;
      }
      const run = spawn(["--program", path, "--format", "json", "--out", "-"]);
      const report = JSON.parse(run.stdout) as Report;
      // Whether the shipped copy is current is the release gate's business; here the point is that the bundle can read it and answers.
      expect([0, 1], `${path}: ${run.stderr}`).toContain(run.status);
      expect(report.program?.detectedAbi, path).toMatch(/^\d+\.\d+\.\d+$/);
    }
  }, TEST_MS);

  it("attacks an endpoint from the bundle: exit 0 and a schema-valid JSON report, with no program", async () => {
    const server = await startReferenceServer();
    try {
      const run = await promisify(execFile)(process.execPath, [bin, "--endpoint", server.url, "--form", "datum-security-suite", "--delay-ms", "0", "--format", "json", "--out", "-"], { cwd: REPO_ROOT, encoding: "utf8", timeout: SPAWN_MS });
      const report = JSON.parse(run.stdout) as Report;
      expect(new Ajv({ strict: false, validateFormats: false }).compile(REPORT_SCHEMA)(report)).toBe(true);
      expect(report).toMatchObject({ verdict: "PASS", run: { modes: ["endpoint"] }, endpoint: { profile: "submissions", preflight: { ok: true } } });
      expect(report.results.some((result) => result.id === "REC-01" && result.status === "PASS")).toBe(true);
    } finally {
      await server.close();
    }
  }, TEST_MS);

  // vitest gives an imported CommonJS module every named export; plain Node 22 does not, so only a spawn of the bundle
  // shows whether the PDF runner can load pdf-lib under the Node it runs on.
  it.skipIf(!existsSync(PDF_PROGRAM_PATH))("inspects PDF output with pdf-lib from the bundle: OUT-03 and OUT-10 pass against the kernel's program", () => {
    const run = spawn(["--pdf-program", PDF_PROGRAM_PATH, "--only", "OUT-03,OUT-10", "--format", "json", "--out", "-"]);
    const report = JSON.parse(run.stdout) as Report;
    for (const id of ["OUT-03", "OUT-10"]) {
      const row = report.results.find((result) => result.id === id);
      expect(row?.status, `${id}: ${row?.notes}`).toBe("PASS");
    }
    expect(run.status, run.stderr).toBe(0);
  }, TEST_MS);

  it("exits 1 for a yes-man program, 2 for no arguments, and prints help", () => {
    expect(spawn(["--program", file("bundled-yes.js", yesManProgramText()), "--only", "CTL-02", "--quiet"]).status).toBe(1);
    const none = spawn([]);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("give --program");
    expect(spawn(["--help"]).stdout).toContain("Usage");
  });
});
