import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEndpoint, runsOnEndpoint, type EndpointRun } from "../src/runners/endpoint/endpoint-runner.js";
import { JOURNEY_ENDPOINT_SPECS } from "../src/runners/endpoint/specs-journeys.js";
import { evaluate } from "../src/predicates.js";
import { VECTORS } from "../src/vectors/index.js";
import { configFor, statusOf } from "./helpers/endpoint.js";
import { startReferenceServer, type ReferenceServer } from "./helpers/reference-submissions-server.js";

const JRN = VECTORS.filter((vector) => vector.class === "journey");
const variantOf = (run: EndpointRun, id: string, row: string) => run.results.find((entry) => entry.id === id)?.variants?.find((variant) => variant.id === row);

describe("the JRN catalogue", () => {
  it("has six vectors with the gates the stage promises", () => {
    expect(JRN.map((vector) => vector.id)).toEqual(["JRN-01", "JRN-02", "JRN-03", "JRN-04", "JRN-05", "JRN-07"]);
    const gates = Object.fromEntries(JRN.map((vector) => [vector.id, vector.gate.status === "pending" ? vector.gate.blockedBy : "enforced"]));
    expect(gates).toEqual({ "JRN-01": "enforced", "JRN-02": "enforced", "JRN-03": "enforced", "JRN-04": "enforced", "JRN-05": "enforced", "JRN-07": "enforced" });
    expect(JRN.find((vector) => vector.id === "JRN-01")?.severity).toBe("S1");
    expect(JRN.find((vector) => vector.id === "JRN-07")?.severity).toBe("S1");
  });

  it("runs JRN-01, 03 and 07 against an endpoint, and JRN-02, 04 and 05 not", () => {
    const on = JRN.filter((vector) => runsOnEndpoint(vector)).map((vector) => vector.id);
    expect(on).toEqual(["JRN-01", "JRN-03", "JRN-07"]);
    expect(Object.keys(JOURNEY_ENDPOINT_SPECS)).toEqual(on);
  });

  it("records the omitted-journey rule on the vector and its spec", () => {
    const jrn07 = JRN.find((vector) => vector.id === "JRN-07");
    expect(jrn07?.applies.endpoint !== false && jrn07?.applies.endpoint.note).toMatch(/else journey\.required/);
    expect(JOURNEY_ENDPOINT_SPECS["JRN-07"]?.note).toMatch(/else journey\.required/);
  });
});

describe("the journey rows against the reference receiver", () => {
  it("accepts bad_document as well as journey.unknown for a non-string journey id", () => {
    const expectation = JOURNEY_ENDPOINT_SPECS["JRN-03"]?.rows.find((row) => row.id === "check-id-number")?.expect;
    expect(expectation).toBeDefined();
    const verdict = { kind: "verdict" as const, accepted: false, errors: [{ code: "journey.unknown", field: null }] };
    const malformed = { kind: "refusal" as const, refusal: "bad_document" as const, code: "bad_document", detail: "" };
    expect(evaluate(expectation!, verdict).pass).toBe(true);
    expect(evaluate(expectation!, malformed).pass).toBe(true);
    // A string id is still only journey.unknown.
    const proto = JOURNEY_ENDPOINT_SPECS["JRN-03"]?.rows.find((row) => row.id === "check-id-proto")?.expect;
    expect(evaluate(proto!, malformed).pass).toBe(false);
  });

  it("falls back to the default journey when it is asked of a form with two journeys and a declared default, and refuses without one", async () => {
    const base = (await import("../src/fixtures/base-form.js")).BASE_DEFINITION;
    const second = { id: "second", pages: [{ id: "p1", components: ["name"] }] };
    const withDefault = { ...base, journey: { journeys: [...(base.journey as { journeys: unknown[] }).journeys, second], defaultJourneyId: "main" } };
    const withoutDefault = { ...base, journey: { journeys: [...(base.journey as { journeys: unknown[] }).journeys, second] } };
    for (const [definition, expected] of [[withDefault, "journey.exit"], [withoutDefault, "journey.required"]] as const) {
      const server = await startReferenceServer({ definition: definition as never });
      try {
        const result = await runEndpoint(configFor(server.url, { vectors: JRN, allowWrites: true, fixtureAcknowledged: true, only: ["JRN-07"] }));
        expect(variantOf(result, "JRN-07", "check-omitted-with-the-exit-answers")?.observed, expected).toMatchObject({ kind: "verdict", accepted: false, errors: [{ code: expected }] });
        expect(statusOf(result.results, "JRN-07")).toBe("PASS");
      } finally {
        await server.close();
      }
    }
  });

  it("FAILs JRN-01 against a receiver whose fixture has no exit route (a stale installed fixture), naming the control", async () => {
    const base = (await import("../src/fixtures/base-form.js")).BASE_DEFINITION;
    const stale = structuredClone(base) as unknown as { journey: { journeys: { pages: { routes?: unknown }[] }[] } };
    // a fixture with one page, no route to an exit
    delete stale.journey.journeys[0]?.pages[0]?.routes;
    stale.journey.journeys[0]?.pages.splice(1);
    const server = await startReferenceServer({ definition: stale as never });
    try {
      const run = await runEndpoint(configFor(server.url, { vectors: JRN, only: ["JRN-01"] }));
      expect(statusOf(run.results, "JRN-01")).toBe("FAIL");
      expect(variantOf(run, "JRN-01", "check-the-exit-answers-through-main")?.status).toBe("FAIL");
    } finally {
      await server.close();
    }
  });
});

describe("the reference @argusvane/datum-submissions service", () => {
  let server: ReferenceServer;
  let release: EndpointRun;
  let full: EndpointRun;

  beforeAll(async () => {
    server = await startReferenceServer();
    release = await runEndpoint(configFor(server.url, { vectors: JRN, allowWrites: true, fixtureAcknowledged: true }));
    full = await runEndpoint(configFor(server.url, { vectors: JRN, allowWrites: true, fixtureAcknowledged: true, gate: "full" }));
  }, 120_000);
  afterAll(async () => server.close());

  it("refuses the exit answers when the journey is named and answers journey.unknown for the hostile ids", () => {
    expect(statusOf(release.results, "JRN-01")).toBe("PASS");
    expect(statusOf(release.results, "JRN-03")).toBe("PASS");
  });

  it("judges a journey-less request by the form's journey: JRN-07 is enforced and PASSes, release and full", () => {
    for (const run of [release, full]) {
      const jrn07 = run.results.find((entry) => entry.id === "JRN-07");
      expect(jrn07?.status).toBe("PASS");
      expect(jrn07?.gate).toBe("enforced");
      expect(variantOf(run, "JRN-07", "check-omitted-with-the-exit-answers")?.observed).toMatchObject({ kind: "verdict", accepted: false, errors: [{ code: "journey.exit" }] });
      expect(variantOf(run, "JRN-07", "submit-omitted-with-the-exit-answers")?.status).toBe("PASS");
    }
  });
});
