import { describe, expect, it } from "vitest";

import { decideVerdict } from "../src/report/model.js";
import { runBuilder } from "../src/runners/endpoint/profiles/builder-lifecycle.js";
import { builderConfigFor, rowStatuses, statusOf } from "./helpers/builder.js";
import { startReferenceBuilderServer, type ReferenceBuilderOptions } from "./helpers/reference-submissions-builder-server.js";

async function against(options: ReferenceBuilderOptions, overrides: Parameters<typeof builderConfigFor>[1] = {}) {
  const server = await startReferenceBuilderServer(options);
  try {
    const run = await runBuilder(builderConfigFor(server.url, { gate: "full", ...overrides }));
    const left = (await server.service.listCatalog()).length;
    return { run, server, left, failing: run.results.filter((entry) => entry.status === "FAIL").map((entry) => entry.id) };
  } finally {
    await server.close();
  }
}

describe("the builder profile against @argusvane/datum-submissions (the real service behind node:http)", () => {
  it("passes every enforced row against the reference host, registers and deletes the form, and sends only the routes of the plan", async () => {
    const { run, server, left } = await against({}, { heavy: false });
    expect(run.inconclusive).toEqual([]);
    expect(run.results.filter((entry) => entry.status === "FAIL" || entry.status === "ERROR").map((entry) => entry.id)).toEqual([]);
    expect(statusOf(run.results, "BLD-07")).toBe("PASS");
    expect(statusOf(run.results, "BLD-10")).toBe("PASS");
    expect(rowStatuses(run.results, "BLD-08")["anonymous-copy"]).toBe("PASS");
    expect(statusOf(run.results, "DEF-09")).toBe("PASS");
    expect(left).toBe(0);
    const templates = new Set(server.seen.map((entry) => `${entry.method} ${entry.path.replace(/\/api\/forms\/[^/]+/, "/api/forms/{key}")}${entry.search}`));
    expect([...templates].sort()).toEqual(
      [
        "DELETE /api/forms/{key}?cascade=true",
        "GET /api/forms/{key}/definition",
        "GET /api/forms/{key}/inspect?op=check",
        "GET /api/forms/{key}/inspect?op=public",
        "POST /api/forms",
        "POST /api/submissions",
        "POST /api/submissions/validate"
      ].sort()
    );
    expect(run.builder.requestsSent).toBeLessThanOrEqual(120);
  }, 120_000);

  it("a host that serves the secret rules from its public route fails BLD-08 and DEF-09", async () => {
    const { failing } = await against({ fault: { leakSecretsInPublic: true } }, { only: ["BLD-08", "DEF-09"] });
    expect(failing.sort()).toEqual(["BLD-08", "DEF-09"]);
  }, 60_000);

  it("a host that answers 500 to a body that is not an object fails DEF-02 and SEC-05 (the never-500 rule)", async () => {
    const { failing, run } = await against({ fault: { crashOnNonObject: true } }, { only: ["DEF-02", "SEC-05"] });
    expect(failing.sort()).toEqual(["DEF-02", "SEC-05"]);
    expect(run.results.find((entry) => entry.id === "DEF-02")?.notes).toMatch(/never-500 rule/);
  }, 60_000);

  it("a host that does not delete leaves the form: BLD-10 is ERROR, with the DELETE as the remedy, and the run is INCONCLUSIVE", async () => {
    const { run } = await against({ fault: { deleteDoesNothing: true } }, { only: ["BLD-07", "BLD-10"] });
    expect(statusOf(run.results, "BLD-10")).toBe("ERROR");
    expect(run.builder.cleanup.remedy).toMatch(/DELETE \/api\/forms\/.*\?cascade=true/);
    expect(decideVerdict(run.results, { failOn: "fail", inconclusive: run.inconclusive }).verdict).toBe("INCONCLUSIVE");
  }, 60_000);

  it("a save under another version registers another catalogue key, which the cleanup deletes too", async () => {
    const server = await startReferenceBuilderServer();
    try {
      const { HttpClient } = await import("../src/runners/endpoint/http.js");
      const { Budget } = await import("../src/runners/endpoint/budget.js");
      const { submissionsBuilderHost } = await import("../src/runners/endpoint/profiles/builder-submissions.js");
      const { baseBody } = await import("../src/runners/endpoint/profiles/builder-specs.js");
      const config = builderConfigFor(server.url);
      const ctx = { config, host: submissionsBuilderHost, formId: "secsuite_cafe0001", formVersion: "1", keys: new Set<string>(), saves: 0, recordsCreated: 0 } as never as Parameters<typeof submissionsBuilderHost.save>[0];
      (ctx as { client: unknown }).client = new HttpClient({ target: { baseUrl: server.url, profile: "submissions", formId: "secsuite_cafe0001", formVersion: "1", allowWrites: true }, budget: new Budget({ maxRequests: 50, delayMs: 0 }), timeoutMs: 5000, headers: {}, allow: submissionsBuilderHost.allow(ctx) });
      const other = baseBody({ formId: "secsuite_cafe0001" }).replace('"version":"1"', '"version":"2"');
      await submissionsBuilderHost.save(ctx, { body: baseBody({ formId: "secsuite_cafe0001" }) }, "t/one");
      await submissionsBuilderHost.save(ctx, { body: other }, "t/two");
      expect((await server.service.listCatalog()).length).toBe(2);
      expect((await submissionsBuilderHost.remove(ctx)).complete).toBe(true);
      expect((await server.service.listCatalog()).length).toBe(0);
      expect(await submissionsBuilderHost.isGone(ctx)).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);

  it("SEC-03 on the service: the check answer for a stored secret-rule form names where and which code, never the rule's text", async () => {
    const { run } = await against({}, { only: ["BLD-08"] });
    expect(rowStatuses(run.results, "BLD-08")["check-answer-names-where-and-code"]).toBe("PASS");
    expect(rowStatuses(run.results, "BLD-08")["anonymous-copy"]).toBe("PASS");
  }, 60_000);
});
