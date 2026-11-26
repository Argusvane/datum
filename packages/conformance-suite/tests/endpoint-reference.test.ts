import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Report } from "../src/report/model.js";
import { runEndpoint, type EndpointRun } from "../src/runners/endpoint/endpoint-runner.js";
import { configFor, enforcedProblems, statusOf } from "./helpers/endpoint.js";
import { catalogueWithEveryEndpointSpec } from "./helpers/catalogue.js";
import { startReferenceServer, type ReferenceServer } from "./helpers/reference-submissions-server.js";
import { withEndpoint } from "../src/runners/endpoint/report.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import { Ajv } from "ajv";

const vectors = catalogueWithEveryEndpointSpec();

describe("the reference @argusvane/datum-submissions server (the real service behind node:http)", () => {
  let server: ReferenceServer;
  let readOnly: EndpointRun;

  beforeAll(async () => {
    server = await startReferenceServer({ olderVersion: true });
    readOnly = await runEndpoint(configFor(server.url, { vectors }));
  }, 120_000);
  afterAll(async () => server.close());

  it("runs the submissions profile and passes the preflight", () => {
    expect(readOnly.endpoint).toMatchObject({ preflight: { ok: true, evidence: ["CTL-01", "CTL-02", "OPT-01"] }, writes: false, recordsCreated: 0, rateLimited: false, fixtureVersion: "1" });
    expect(readOnly.inconclusive).toEqual([]);
  });

  it("passes every enforced submissions-profile vector, read-only", () => {
    expect(enforcedProblems(readOnly.results)).toEqual([]);
    const ran = readOnly.results.filter((result) => result.status === "PASS").map((result) => result.id);
    for (const id of ["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06", "RES-05", "RES-06", "RES-08", "RES-11", "OPT-01", "OPT-02", "OPT-03", "OPT-06", "OPT-07", "OPT-08", "FIL-01", "CTX-01", "REC-01", "REC-02", "REC-03", "REC-04", "REC-05", "REC-06", "REC-07", "REC-09", "REC-10", "REC-11", "REC-13", "SEC-01", "SEC-02", "SEC-05"]) {
      expect(ran, id).toContain(id);
    }
  });

  it("reads the version it can only be told is outdated, and proves the strict code when an older version is registered", () => {
    const result = readOnly.results.find((entry) => entry.id === "REC-06");
    expect(result?.variants?.find((variant) => variant.id === "other-version")?.observed).toMatchObject({ refusal: "outdated", code: "version_superseded", http: 409 });
  });

  it("sends no write in read-only mode: every request is a validate, or a read of the form's own definition or record list", () => {
    const writes = server.seen.filter((request) => request.method !== "GET" && request.path !== "/api/submissions/validate");
    expect(writes).toEqual([]);
    expect(server.seen.filter((request) => request.path === "/api/submissions")).toEqual([]);
    expect(server.seen.every((request) => request.method === "POST" || request.method === "GET")).toBe(true);
    expect(readOnly.endpoint.requestsSent).toBe(server.seen.length);
  });

  it("skips the submit-only rows and says why, and skips REC-12 (a replay stores records) without --allow-writes", () => {
    const rec08 = readOnly.results.find((entry) => entry.id === "REC-08");
    expect(rec08?.status).toBe("SKIP");
    expect(rec08?.notes).toMatch(/--allow-writes/);
    expect(statusOf(readOnly.results, "REC-12")).toBe("SKIP");
    expect(statusOf(readOnly.results, "CAN-06")).toBe("SKIP");
    expect(readOnly.results.find((entry) => entry.id === "REC-14")?.notes).toMatch(/no 429/);
    expect(statusOf(readOnly.results, "RES-16")).toBe("SKIP");
  });

  it("writes the fixture form's own records only with --allow-writes, once the marker is read from the public definition", async () => {
    const before = await server.service.listRecords({ filter: { formKey: server.key } });
    const run = await runEndpoint(configFor(server.url, { vectors, allowWrites: true, gate: "full" }));
    expect(run.endpoint).toMatchObject({ writes: true, preflight: { ok: true } });
    expect(enforcedProblems(run.results)).toEqual([]);
    expect(statusOf(run.results, "REC-08")).toBe("PASS");
    expect(statusOf(run.results, "CAN-06")).toBe("PASS");
    expect(statusOf(run.results, "REC-12")).toBe("PASS");
    expect(run.results.find((entry) => entry.id === "REC-12")?.variants?.[0]?.observed).toMatchObject({ kind: "answer", json: { outcome: "same-record", handled: true } });
    expect(statusOf(run.results, "JRN-07")).toBe("PASS");
    // heavy vectors run under the full gate (pending ones as XPASS/XFAIL, enforced ones as PASS)
    expect(["PASS", "XPASS", "XFAIL"]).toContain(statusOf(run.results, "RES-16"));
    const after = await server.service.listRecords({ filter: { formKey: server.key } });
    // accepted ones are counted by the report; the service also keeps a rejected submission as a record
    expect(after.total - before.total).toBeGreaterThanOrEqual(run.endpoint.recordsCreated);
    expect(run.endpoint.recordsCreated).toBeGreaterThan(0);
    // only the fixture form's records changed: no other catalog entry exists
    expect((await server.service.listCatalogFull()).map((entry) => entry.key).sort()).toEqual(["datum-security-suite@0", "datum-security-suite@1"]);
  }, 120_000);

  it("reports as a valid report, with the endpoint section, and never carries a credential", () => {
    const report = withEndpoint(undefined, readOnly, { failOn: "fail", gate: "release", argv: ["--endpoint", server.url, "--auth-header", "Authorization: Bearer SECRET-TOKEN-123"], startedAt: new Date(), startedMs: performance.now() }) as Report;
    const validate = new Ajv({ strict: false }).compile(REPORT_SCHEMA);
    expect(validate(JSON.parse(JSON.stringify(report))), JSON.stringify(validate.errors)).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report.run.modes).toEqual(["endpoint"]);
    expect(JSON.stringify(report)).not.toContain("SECRET-TOKEN-123");
  });
});
