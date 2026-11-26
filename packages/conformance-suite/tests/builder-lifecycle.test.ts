import { existsSync } from "node:fs";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { REPORT_SCHEMA } from "../src/report/schema.js";
import { renderJson } from "../src/report/json.js";
import { withBuilder } from "../src/runners/endpoint/profiles/builder-report.js";
import { runBuilder } from "../src/runners/endpoint/profiles/builder-lifecycle.js";
import { BUILDER_SPECS } from "../src/runners/endpoint/profiles/builder-specs.js";
import { VECTORS } from "../src/vectors/index.js";
import { builderConfigFor, rowStatuses, statusOf } from "./helpers/builder.js";
import { startReferenceBuilderServer } from "./helpers/reference-submissions-builder-server.js";

const COOKIE = "SESSsuite=1";

const problems = (results: readonly { id: string; status: string; gate: string; notes?: string | undefined }[]): string[] =>
  results.filter((result) => result.gate === "enforced" && result.status !== "PASS" && result.status !== "SKIP" && result.status !== "XFAIL").map((result) => `${result.id} ${result.status}: ${result.notes ?? ""}`);

describe("the builder profile against the reference host", () => {
  it("registers a form, saves hostile definitions into it, reads them back, checks, and deletes the form: no enforced row fails", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { gate: "full", heavy: false }));
      expect(run.inconclusive).toEqual([]);
      expect(problems(run.results)).toEqual([]);
      expect(statusOf(run.results, "BLD-04")).toBe("PASS");
      expect(statusOf(run.results, "BLD-10")).toBe("PASS");
      expect(Object.keys(rowStatuses(run.results, "BLD-06")).length).toBeGreaterThan(5);
      expect((await server.service.listCatalog()).length).toBe(0);
      expect(run.builder.requestsSent).toBeLessThanOrEqual(120);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("a release check does not send the heavy rows", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const release = await runBuilder(builderConfigFor(server.url, { gate: "release" }));
      expect(statusOf(release.results, "BLD-05")).toBe("SKIP");
      expect(release.results.find((result) => result.id === "BLD-05")?.notes).toMatch(/heavy/);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("judges the DEF rows as enforced under the release gate", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { gate: "release", only: ["DEF-03"] }));
      expect(run.results.find((result) => result.id === "DEF-03")?.gate).toBe("enforced");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("sends the one oversize body (limit + 1 byte) only under --heavy, and the host refuses it", async () => {
    const limit = 120_000;
    const server = await startReferenceBuilderServer({ maxBody: limit });
    try {
      const run = await runBuilder(builderConfigFor(server.url, { heavy: true, definitionLimit: limit, only: ["BLD-05"] }));
      expect(statusOf(run.results, "BLD-05")).toBe("PASS");
      const biggest = Math.max(...server.seen.map((entry) => entry.bytes));
      expect(biggest).toBe(limit + 1);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("every request of a run is on the allowlist", () => {
  it("the HttpClient guard throws on any request outside the list (another form, the forms list, a PATCH)", async () => {
    const { HttpClient, AllowlistViolation } = await import("../src/runners/endpoint/http.js");
    const { Budget } = await import("../src/runners/endpoint/budget.js");
    const { submissionsBuilderHost } = await import("../src/runners/endpoint/profiles/builder-submissions.js");
    const config = builderConfigFor("http://127.0.0.1:9");
    const ctx = { config, formId: "secsuite_aaaaaaaa", formVersion: "1", keys: new Set<string>() } as never;
    const client = new HttpClient({
      target: { baseUrl: config.baseUrl, profile: "submissions", formId: "secsuite_aaaaaaaa", formVersion: "1", allowWrites: true },
      budget: new Budget({ maxRequests: 10, delayMs: 0 }),
      timeoutMs: 100,
      headers: {},
      allow: submissionsBuilderHost.allow(ctx)
    });
    for (const [method, path] of [
      ["PATCH", "/api/forms"],
      ["PUT", "/api/submissions"],
      ["GET", "/admin"],
      ["GET", "/api/other"]
    ] as const) {
      expect(() => client.assertAllowed(method, `http://127.0.0.1:9${path}`), `${method} ${path}`).toThrow(AllowlistViolation);
    }
    expect(() => client.assertAllowed("GET", "http://evil.example/api/forms")).toThrow(AllowlistViolation);
    expect(() => client.assertAllowed("POST", "http://127.0.0.1:9/api/forms")).not.toThrow();
  });
});

describe("the form is cleaned up whatever happens", () => {
  it("deletes the form when the run is aborted (SIGINT), and the state file is gone", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const controller = new AbortController();
      let results = 0;
      const config = builderConfigFor(server.url, { signal: controller.signal, onResult: () => { results += 1; if (results === 2) controller.abort(); } });
      const run = await runBuilder(config);
      expect(run.inconclusive.join(" ")).toMatch(/interrupted/);
      expect(run.results.length).toBeGreaterThanOrEqual(2);
      expect((await server.service.listCatalog()).length).toBe(0);
      expect(existsSync(config.stateFile)).toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("reports an incomplete cleanup with the remedy and the run is INCONCLUSIVE", async () => {
    const server = await startReferenceBuilderServer({ fault: { deleteDoesNothing: true } });
    try {
      const config = builderConfigFor(server.url, { only: ["BLD-07", "BLD-10"] });
      const run = await runBuilder(config);
      expect(statusOf(run.results, "BLD-10")).toBe("ERROR");
      expect(run.builder.cleanup.complete).toBe(false);
      expect(run.builder.cleanup.remedy).toMatch(/DELETE \/api\/forms\//);
      expect(existsSync(config.stateFile)).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("stops with INCONCLUSIVE when the server rate-limits the run, and still tries to clean up", async () => {
    const server = await startReferenceBuilderServer();
    try {
      let calls = 0;
      const config = builderConfigFor(server.url, {
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          if (calls === 20) {
            return Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "120", "content-type": "application/json" } }));
          }
          return fetch(input, init);
        }) as typeof fetch
      });
      const run = await runBuilder(config);
      expect(run.inconclusive.join(" ")).toMatch(/429/);
      expect((await server.service.listCatalog()).length).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("stops at the request budget with INCONCLUSIVE and still deletes the form (the cleanup has its own reserve)", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { maxRequests: 40 }));
      expect(run.inconclusive.join(" ")).toMatch(/request budget/);
      expect((await server.service.listCatalog()).length).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("stops at the save budget with INCONCLUSIVE and still deletes the form", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { maxSaves: 6 }));
      expect(run.inconclusive.join(" ")).toMatch(/save budget/);
      expect((await server.service.listCatalog()).length).toBe(0);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("the report", () => {
  it("is valid against the report schema and carries the builder section, the request counts and no credential", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { only: ["DEF-02", "BLD-06"], headers: { cookie: COOKIE } }));
      const report = withBuilder(undefined, run, { failOn: "fail", gate: "full", argv: ["--endpoint", server.url, "--builder", "--cookie", COOKIE], startedAt: new Date(), startedMs: performance.now() });
      const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(REPORT_SCHEMA);
      expect(validate(JSON.parse(renderJson(report))), JSON.stringify(validate.errors)).toBe(true);
      expect(report.run.modes).toEqual(["builder"]);
      expect(renderJson(report)).not.toContain(COOKIE);
      expect(report.builder?.authHeaderName).toBe("cookie");
      expect(report.results.every((result) => result.runner === "builder")).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("registers a builder row table for every DEF vector that applies and for the BLD vectors", () => {
    for (const vector of VECTORS.filter((entry) => entry.class === "definition")) {
      const applies = vector.applies.endpoint;
      expect(BUILDER_SPECS[vector.id] !== undefined, `${vector.id} ${applies === false ? "(no builder)" : ""}`).toBe(applies !== false);
    }
    for (const vector of VECTORS.filter((entry) => entry.class === "builder" && !["BLD-04", "BLD-09", "BLD-10", "BLD-11"].includes(entry.id))) {
      expect(BUILDER_SPECS[vector.id], vector.id).toBeDefined();
    }
  });
});

describe("existing vectors that have a builder form", () => {
  it("selecting REC-01 in a builder run runs the rows of BLD-06, reported under BLD-06; REC-11 brings DEF-07", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { only: ["REC-01", "REC-11"], gate: "full" }));
      expect(run.results.map((result) => result.id)).toEqual(["DEF-07", "BLD-06"]);
      expect(rowStatuses(run.results, "BLD-06")["open-brace"]).toBe("PASS");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("--skip still removes a vector that a mapping would bring", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const run = await runBuilder(builderConfigFor(server.url, { only: ["REC-04"], skip: ["DEF-06"], gate: "full" }));
      expect(run.results.map((result) => result.id)).toEqual(["BLD-06"]);
    } finally {
      await server.close();
    }
  }, 60_000);
});
