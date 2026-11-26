import { describe, expect, it } from "vitest";

import type { WasmSubmissionContext } from "@argusvane/datum-engine";
import { createKernelValidator, type SubmissionValidator } from "@argusvane/datum-submissions";

import { runEndpoint } from "../src/runners/endpoint/endpoint-runner.js";
import type { VectorResult } from "../src/report/model.js";
import { decideVerdict } from "../src/report/model.js";
import { catalogueWithEveryEndpointSpec } from "./helpers/catalogue.js";
import { configFor, statusOf } from "./helpers/endpoint.js";
import { startReferenceServer, type ReferenceServerOptions } from "./helpers/reference-submissions-server.js";

const vectors = catalogueWithEveryEndpointSpec();

/** The reference server with one thing wrong, run read-only (and with writes where the vector needs them). */
async function against(options: ReferenceServerOptions, overrides: Parameters<typeof configFor>[1] = {}) {
  const server = await startReferenceServer(options);
  try {
    const run = await runEndpoint(configFor(server.url, { vectors, ...overrides }));
    return { run, server, failing: (run.results as VectorResult[]).filter((entry) => entry.status === "FAIL").map((entry) => entry.id) };
  } finally {
    await server.close();
  }
}

describe("negative servers: each is the reference server with one thing wrong, and must FAIL the matching vector", () => {
  it("answers 500 to a body that is not JSON: REC-01 and SEC-05 fail (the never-500 rule), CTL controls still pass", async () => {
    const { run, failing } = await against({
      fault: (request) => (!request.jsonOk ? { status: 500, body: "<html><pre>Stack trace: boom at /var/www/html/index.php</pre></html>" } : undefined)
    });
    expect(failing).toContain("REC-01");
    expect(failing).toContain("SEC-05");
    expect(run.results.find((entry) => entry.id === "REC-01")?.notes).toMatch(/never-500 rule/);
    expect(statusOf(run.results, "CTL-01")).toBe("PASS");
    expect(run.endpoint.preflight.ok).toBe(true);
  });

  it("leaks a stack trace in an error body: SEC-05 fails and names the marker", async () => {
    const { run, failing } = await against({
      fault: (request) =>
        request.bodyText.includes("x".repeat(41)) ? { status: 200, contentType: "application/json", body: JSON.stringify({ accepted: false, errors: [{ field: "name", code: "maxLength", message: "Exception in /var/www/html/vendor/datum/Receiver.php:88" }] }) } : undefined
    });
    expect(failing).toContain("SEC-05");
    expect(run.results.find((entry) => entry.id === "SEC-05")?.notes).toMatch(/"Exception"/);
    expect(failing).not.toContain("CTL-03"); // the verdict itself is right; only the leak is wrong
  });

  it("accepts a select answer outside the options when it is 'evil': OPT-06 fails, and OPT-01 (which the preflight also uses) still passes", async () => {
    const lenient: SubmissionValidator = {
      id: "option-blind",
      async validate(context: WasmSubmissionContext) {
        const outcome = await createKernelValidator().validate(context);
        return JSON.stringify(context.values).includes('"evil"') ? { ...outcome, errors: outcome.errors.filter((error) => error.code !== "option.notAllowed") } : outcome;
      }
    };
    const { run, failing } = await against({ validator: lenient });
    expect(failing).toContain("OPT-06");
    expect(failing).not.toContain("OPT-01");
    expect(run.endpoint.preflight.ok).toBe(true);
  });

  it("a yes-man that accepts everything fails the preflight: INCONCLUSIVE, not a long list of failures", async () => {
    const yesMan: SubmissionValidator = { id: "yes", async validate(context) { return { ...(await createKernelValidator().validate(context)), errors: [] }; } };
    const { run } = await against({ validator: yesMan });
    expect(run.endpoint.preflight.ok).toBe(false);
    expect(run.inconclusive.join()).toMatch(/preflight CTL-02/);
    expect(run.inconclusive.join()).toMatch(/does not behave as the fixture form/);
    expect(run.results.map((entry) => entry.status)).toEqual(["ERROR"]);
  });

  it("serves an HTML 200 for a text/plain post: REC-10 fails as a malformed answer", async () => {
    const { failing } = await against({ fault: (request) => (request.headers["content-type"] === "text/plain" ? { status: 200, body: "<html>ok</html>" } : undefined) });
    expect(failing).toContain("REC-10");
    expect(failing).toContain("SEC-05");
  });

  it("answers a hang with nothing: the vector fails by its time bound, the rest of the run goes on", async () => {
    const { run, failing } = await against({ fault: (request) => (request.bodyText.includes(`${"a".repeat(40)}!`) ? { hang: true, status: 0, body: "" } : undefined) }, { timeoutMs: 400 });
    expect(failing).toContain("RES-11");
    expect(run.results.find((entry) => entry.id === "RES-11")?.variants?.[0]?.observed).toMatchObject({ kind: "refusal", refusal: "budget", code: "timeout" });
    expect(statusOf(run.results, "OPT-01")).toBe("PASS");
  }, 30_000);

  it("has no host body cap: RES-05 WARNs that the limit differs, REC-03 is answered by the service's own cap (413 payload_too_large)", async () => {
    const { run } = await against({ bodyLimit: null });
    expect(statusOf(run.results, "RES-05")).toBe("WARN");
    // The exact-limit row is the host's (the service measures the document inside the wrapper): WARN. The row 64 KiB over meets the service's own cap.
    const rec03 = run.results.find((entry) => entry.id === "REC-03");
    expect(rec03?.variants?.find((variant) => variant.id === "over-the-limit")?.status).toBe("WARN");
    expect(rec03?.variants?.find((variant) => variant.id === "well-over-the-limit")).toMatchObject({ status: "PASS", observed: { kind: "refusal", refusal: "too_large", http: 413, code: "payload_too_large" } });
    expect(run.results.find((entry) => entry.id === "RES-05")?.notes).toMatch(/limit differs/);
    expect(decideVerdict(run.results, { failOn: "fail" }).verdict).toBe("PASS");
    expect(decideVerdict(run.results, { failOn: "warn" }).verdict).toBe("FAIL");
  });

  it("fails an open form: nothing rejects a check with scope everything", async () => {
    const { failing } = await against({
      fault: (request) => (request.bodyText.includes('"scope":"everything"') ? { status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true, errors: [] }) } : undefined)
    });
    expect(failing).toContain("REC-05");
  });

  it("accepts a signed wrapper with a smuggled sibling (writes): REC-08 fails", async () => {
    const { failing } = await against(
      { fault: (request) => (request.path === "/api/submissions" && request.bodyText.includes('"smuggled"') ? { status: 200, contentType: "application/json", body: JSON.stringify({ id: "x", status: "accepted", digest: "0" }) } : undefined) },
      { allowWrites: true }
    );
    expect(failing).toContain("REC-08");
  });

  it("stores a record for a check: REC-13 fails", async () => {
    const server = await startReferenceServer();
    try {
      // a server whose validate route also writes: wrap it by registering a record on every validate call
      const original = server.service.validate.bind(server.service);
      let seq = 0;
      server.service.validate = async (input) => {
        const verdict = await original(input);
        await server.service.receive({ document: { versionContext: { form: { id: "datum-security-suite", version: "1" } }, submission: { locale: "en", values: { name: `n${(seq += 1)}`, addr: { city: "x" } } } } as never, submissionKey: `check-${seq}` });
        return verdict;
      };
      const run = await runEndpoint(configFor(server.url, { vectors, only: ["REC-13"] }));
      expect(statusOf(run.results, "REC-13")).toBe("FAIL");
    } finally {
      await server.close();
    }
  });

  it("keeps the operator's credentials out of the results even when the server echoes them", async () => {
    const { run } = await against(
      {
        fault: (request) =>
          request.bodyText.includes("x".repeat(41))
            ? { status: 200, contentType: "application/json", body: JSON.stringify({ accepted: false, errors: [{ field: "name", code: "maxLength", message: `echo ${String(request.headers["authorization"])}` }] }) }
            : undefined
      },
      { headers: { authorization: "Bearer TOKEN-ECHOED-123" } }
    );
    const text = JSON.stringify(run.results);
    expect(text).not.toContain("TOKEN-ECHOED-123");
    expect(text).toContain("[redacted]");
  });

  it("when the server never rate limits, REC-14 has nothing to judge and says so", async () => {
    const { run } = await against({}, { only: ["REC-14", "CTL-01"] });
    expect(run.results.find((entry) => entry.id === "REC-14")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("never provokes") });
  });
});
