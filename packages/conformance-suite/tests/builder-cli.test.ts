import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import type { Report } from "../src/report/model.js";
import { builderConfigFrom } from "../src/runners/endpoint/profiles/builder-config.js";
import { catalogKey } from "../src/runners/endpoint/http.js";
import { baseBody } from "../src/runners/endpoint/profiles/builder-specs.js";
import { startReferenceBuilderServer } from "./helpers/reference-submissions-builder-server.js";

const ADMIN_COOKIE = "SESS=1";

function capture() {
  let out = "";
  let err = "";
  return { io: { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) }, out: () => out, err: () => err };
}

const stateIn = (): string => join(mkdtempSync(join(tmpdir(), "datum-sc-cli-")), "run.json");

describe("builder flags", () => {
  it("parses the builder's knobs and keeps the cookies out of the report's argv", () => {
    const options = parseArgs(["--endpoint", "https://x.example", "--builder", "--builder-form", "mine", "--state-file", "/tmp/s.json", "--definition-limit", "1000", "--max-saves", "12", "--dry-run", "--cookie", "SESS=1", "--allow-writes"]);
    expect(options).toMatchObject({ builder: true, builderForm: "mine", stateFile: "/tmp/s.json", definitionLimit: 1000, maxSaves: 12, dryRun: true });
    const config = builderConfigFrom(options, {});
    expect(config).toMatchObject({ host: "submissions", builderForm: "mine", maxRequests: 120, maxSaves: 12 });
    expect(config.headers).toEqual({ cookie: "SESS=1" });
  });

  it("refuses what cannot work", () => {
    for (const argv of [["--builder-host", "php"], ["--builder-low-cookie", "x"], ["--definition-limit", "0"], ["--max-saves", "x"], ["--builder-abi", "4.0.0"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
    expect(() => builderConfigFrom(parseArgs(["--builder"]), {})).toThrow(/needs --endpoint/);
    expect(() => builderConfigFrom(parseArgs(["--builder", "--endpoint", "https://x.example", "--cookie", "S=1"]), {})).toThrow(/--allow-writes/);
    expect(() => builderConfigFrom(parseArgs(["--builder", "--endpoint", "https://u:p@x.example", "--allow-writes", "--cookie", "S=1"]), {})).toThrow(/credentials/);
    expect(builderConfigFrom(parseArgs(["--builder", "--endpoint", "https://x.example", "--allow-writes"]), {}).host).toBe("submissions");
    expect(builderConfigFrom(parseArgs(["--builder", "--endpoint", "https://x.example", "--allow-writes"]), { DATUM_SC_COOKIE: "S=1" }).headers["cookie"]).toBe("S=1");
  });
});

describe("the command line", () => {
  it("refuses builder flags without --builder and a builder run without --allow-writes: exit 2, and not one request is sent", async () => {
    const server = await startReferenceBuilderServer();
    try {
      for (const argv of [["--endpoint", server.url, "--state-file", stateIn()], ["--endpoint", server.url, "--builder", "--cookie", ADMIN_COOKIE]]) {
        const run = capture();
        expect(await runCli(argv, run.io), argv.join(" ")).toBe(EXIT.usage);
      }
      expect(server.seen).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("--dry-run prints the plan and sends nothing", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = capture();
      const code = await runCli(["--endpoint", server.url, "--builder", "--dry-run", "--state-file", stateIn()], run.io);
      expect(code).toBe(EXIT.pass);
      expect(run.out()).toMatch(/creates a form secsuite_<8 hex>/);
      expect(run.out()).toMatch(/DEF-03: \(base\)/);
      expect(run.out()).toMatch(/BLD-06: empty-body, open-brace/);
      expect(run.out()).toMatch(/BLD-05 \(heavy: skipped without --heavy\)/);
      expect(server.seen).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("runs the builder profile: exit 0, a JSON report with the builder section, no cookie in it, the form gone", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = capture();
      const state = stateIn();
      const code = await runCli(["--endpoint", server.url, "--builder", "--allow-writes", "--cookie", ADMIN_COOKIE, "--state-file", state, "--delay-ms", "0", "--only", "BLD-04,BLD-07,BLD-10", "--format", "json", "--out", "-"], run.io);
      // The plan comes first, on stderr; stdout is the report alone.
      expect(run.err()).toMatch(/^Builder run against .* creates a form secsuite_<8 hex>/);
      expect(run.err()).not.toContain(ADMIN_COOKIE);
      expect(code).toBe(EXIT.pass);
      const report = JSON.parse(run.out()) as Report;
      expect(report.verdict).toBe("PASS");
      expect(report.run.modes).toEqual(["builder"]);
      expect(report.builder).toMatchObject({ host: "submissions", mode: "create", cleanup: { complete: true } });
      expect(report.results.map((result) => result.id)).toEqual(["BLD-04", "BLD-07", "BLD-10"]);
      expect(run.out()).not.toContain(ADMIN_COOKIE);
      expect(JSON.stringify(report.run.argv)).not.toContain(ADMIN_COOKIE);
      expect((await server.service.listCatalog()).length).toBe(0);
      expect(existsSync(state)).toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("exits 1 when an enforced row fails and 3 when the cleanup is incomplete", async () => {
    const leak = await startReferenceBuilderServer({ fault: { leakSecretsInPublic: true } });
    const stuck = await startReferenceBuilderServer({ fault: { deleteDoesNothing: true } });
    try {
      const failing = capture();
      expect(await runCli(["--endpoint", leak.url, "--builder", "--allow-writes", "--cookie", ADMIN_COOKIE, "--state-file", stateIn(), "--delay-ms", "0", "--only", "BLD-08", "--quiet"], failing.io)).toBe(EXIT.fail);
      const inconclusive = capture();
      expect(await runCli(["--endpoint", stuck.url, "--builder", "--allow-writes", "--cookie", ADMIN_COOKIE, "--state-file", stateIn(), "--delay-ms", "0", "--only", "BLD-07,BLD-10", "--quiet"], inconclusive.io)).toBe(EXIT.inconclusive);
    } finally {
      await leak.close();
      await stuck.close();
    }
  }, 60_000);

  it("builder-cleanup removes the form a killed run left, from the state file, and removes the file", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const registered = await fetch(`${server.url}/api/forms`, { method: "POST", headers: { "content-type": "application/json" }, body: baseBody({ formId: "secsuite_dead0001" }) });
      expect(registered.status).toBe(201);
      expect((await server.service.listCatalog()).length).toBe(1);
      const state = stateIn();
      writeFileSync(state, JSON.stringify({ version: 1, runId: "dead0001", host: "submissions", baseUrl: server.url, formId: "secsuite_dead0001", formVersion: "1", mode: "create", phase: "created", startedAt: new Date().toISOString(), recordsCreated: 0, keys: [catalogKey("secsuite_dead0001", "1")] }));
      const run = capture();
      const code = await runCli(["builder-cleanup", "--endpoint", server.url, "--cookie", ADMIN_COOKIE, "--state-file", state, "--delay-ms", "0"], run.io);
      expect(run.err()).toBe("");
      expect(code).toBe(EXIT.pass);
      expect(run.out()).toMatch(/cleaned up secsuite_dead0001/);
      expect((await server.service.listCatalog()).length).toBe(0);
      expect(existsSync(state)).toBe(false);
      // Nothing left to do the second time.
      const again = capture();
      expect(await runCli(["builder-cleanup", "--endpoint", server.url, "--cookie", ADMIN_COOKIE, "--state-file", state], again.io)).toBe(EXIT.pass);
      expect(again.out()).toMatch(/nothing to clean up/);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("builder-cleanup refuses a state file written for another server", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const state = stateIn();
      writeFileSync(state, JSON.stringify({ version: 1, runId: "x", host: "submissions", baseUrl: "https://other.example", formId: "secsuite_dead0002", formVersion: "1", mode: "create", phase: "created", startedAt: "now", recordsCreated: 0 }));
      const run = capture();
      expect(await runCli(["builder-cleanup", "--endpoint", server.url, "--cookie", ADMIN_COOKIE, "--state-file", state], run.io)).toBe(EXIT.inconclusive);
      expect(run.err()).toMatch(/for https:\/\/other\.example/);
      expect(server.seen).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("explain shows the builder rows and the gates; list --json says which vectors run on the builder", async () => {
    const explain = capture();
    expect(await runCli(["explain", "DEF-03"], explain.io)).toBe(EXIT.pass);
    expect(explain.out()).toMatch(/runs on: program, builder/);
    expect(explain.out()).toMatch(/gate enforced/);
    expect(explain.out()).toMatch(/builder row \(base\): refusal definition_refused/);
    const bld = capture();
    expect(await runCli(["explain", "BLD-06"], bld.io)).toBe(EXIT.pass);
    expect(bld.out()).toMatch(/builder row empty-body: refusal bad_document/);
    const listing = capture();
    expect(await runCli(["list", "--json"], listing.io)).toBe(EXIT.pass);
    const parsed = JSON.parse(listing.out()) as { vectors: { id: string; applies: { builder: boolean; program: boolean } }[] };
    expect(parsed.vectors.find((vector) => vector.id === "BLD-06")?.applies).toMatchObject({ builder: true, program: false });
    expect(parsed.vectors.find((vector) => vector.id === "DEF-15")?.applies.builder).toBe(false);
    expect(parsed.vectors.find((vector) => vector.id === "CTL-01")?.applies.builder).toBe(false);
  });
});
