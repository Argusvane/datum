import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { afterEach, describe, expect, it } from "vitest";

import { runEndpoint } from "../src/runners/endpoint/endpoint-runner.js";
import { RECEIVER_ENDPOINT_SPECS } from "../src/runners/endpoint/specs-receiver.js";
import { DERIVED_VECTOR_IDS } from "../src/vectors/receiver.js";
import { VECTORS } from "../src/vectors/index.js";
import { VECTOR_SET_ID, DEFAULT_ABI_FLOOR } from "../src/version.js";
import { runSuite } from "../src/run.js";
import { builtProgram } from "./helpers/programs.js";
import { configFor, statusOf } from "./helpers/endpoint.js";
import { startReferenceServer, type FaultAnswer, type ParsedRequest, type ReferenceServer } from "./helpers/reference-submissions-server.js";

/**
 * The decided items as enforced vectors, and the vectors added for
 * them. The mutation tests are in mutation-programs.test.ts; the PDF rows in pdf-runner.test.ts.
 */
const byId = (id: string) => VECTORS.find((vector) => vector.id === id);

describe("the catalogue with the decided items enforced", () => {
  it("floors at the sandbox ABI's major, bumps the vector set, and enforces what was pending on a decision", () => {
    // The floor is the major's first release, so a minor bump of the program does not move it.
    expect(DEFAULT_ABI_FLOOR).toBe(`${WASM_ABI_VERSION.split(".")[0]}.0.0`);
    expect(VECTOR_SET_ID).toBe("2026.11.15-2");
    for (const id of ["ISO-04", "RES-02", "OPT-11", "OPT-12", "OPT-13", "REC-12", "JRN-07", "RES-19", "RES-20"]) {
      expect(byId(id)?.gate.status, id).toBe("enforced");
    }
  });

  it("adds RES-19 (worker host), RES-20 (outcome cap), REC-16 (503, derived) and OUT-13..15", () => {
    expect(byId("RES-19")?.fixture.host).toBe("worker");
    expect(byId("RES-20")?.expect).toMatchObject({ op: "refusal", anyOf: ["too_large"], codes: ["outcome_too_large"] });
    expect(Object.keys(RECEIVER_ENDPOINT_SPECS)).not.toContain("REC-15");
    expect(DERIVED_VECTOR_IDS).toContain("REC-16");
    expect(byId("REC-16")?.gate.status).toBe("advisory");
    expect(["OUT-13", "OUT-14", "OUT-15"].map((id) => byId(id)?.class)).toEqual(["output", "output", "output"]);
    expect(VECTORS.filter((vector) => vector.fixture.host === "worker").map((vector) => vector.id)).toEqual(["RES-19"]);
  });

  it("runs the ISO-04 / RES-02 / RES-19 / RES-20 rows against the program built from source", async () => {
    const report = await runSuite({ program: builtProgram(), only: ["ISO-04", "RES-02", "RES-19", "RES-20", "OPT-11", "OPT-12", "OPT-13", "FIL-01"], gate: "release" });
    expect(report.results.map((result) => `${result.id} ${result.status}`)).toEqual(["ISO-04 PASS", "RES-02 PASS", "RES-19 PASS", "RES-20 PASS", "OPT-11 PASS", "OPT-12 PASS", "OPT-13 PASS", "FIL-01 PASS"]);
    expect(report.results.find((result) => result.id === "RES-20")?.observed).toMatchObject({ kind: "refusal", refusal: "too_large", code: "outcome_too_large" });
  }, 120_000);
});

describe("REC-16, SEC-05 and the replay row against the reference service", () => {
  let server: ReferenceServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const run = async (fault: ((request: ParsedRequest) => FaultAnswer | undefined) | undefined, only: string[]) => {
    server = await startReferenceServer(fault !== undefined ? { fault } : {});
    return runEndpoint(configFor(server.url, { vectors: VECTORS.filter((vector) => only.includes(vector.id)), allowWrites: true, fixtureAcknowledged: true }));
  };
  // REC-05 names another form; the control rows of the preflight never do.
  const namesOtherForm = (request: ParsedRequest): boolean => {
    const form = (request.json as { document?: { versionContext?: { form?: { id?: unknown } } } } | undefined)?.document?.versionContext?.form;
    return request.method === "POST" && form !== undefined && form.id !== "datum-security-suite";
  };

  it("SEC-05 sees a framework's HTML 415", async () => {
    const result = await run((request) => (request.method === "POST" && request.headers["content-type"] === "text/plain" ? { status: 415, contentType: "text/html", body: "<html>Unsupported Media Type</html>" } : undefined), ["REC-10", "SEC-05"]);
    expect(statusOf(result.results, "SEC-05")).toBe("FAIL");
  });

  it("REC-16 is SKIP when no 503 was met, PASS for a typed server.busy, and WARN for a bare 503 page", async () => {
    expect(result503(await run(undefined, ["REC-05", "REC-16"]))).toMatch(/no 503 was met/);
    const typed = await run((request) => (namesOtherForm(request) ? { status: 503, contentType: "application/json", body: JSON.stringify({ errors: [{ field: null, code: "server.busy" }] }) } : undefined), ["REC-05", "REC-16"]);
    expect(statusOf(typed.results, "REC-16")).toBe("PASS");
    expect(typed.results.find((entry) => entry.id === "REC-16")?.observed).toMatchObject({ kind: "refusal", refusal: "unavailable", http: 503, code: "server.busy" });
    const untyped = await run((request) => (namesOtherForm(request) ? { status: 503, contentType: "text/html", body: "<html>Service Unavailable</html>" } : undefined), ["REC-05", "REC-16"]);
    expect(statusOf(untyped.results, "REC-16")).toBe("WARN");
  }, 60_000);

  it("REC-12 runs the replay rule on the submissions service", async () => {
    const result = await run(undefined, ["REC-12"]);
    expect(statusOf(result.results, "REC-12")).toBe("PASS");
  });
});

const result503 = (result: { results: { id: string; notes?: string; status: string }[] }): string | undefined => result.results.find((entry) => entry.id === "REC-16")?.notes;
