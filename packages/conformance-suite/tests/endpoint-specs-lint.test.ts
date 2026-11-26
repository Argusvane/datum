import { describe, expect, it } from "vitest";

import { EARLIER_ENDPOINT_SPECS } from "../src/runners/endpoint/applicability.js";
import { runsOnEndpoint } from "../src/runners/endpoint/endpoint-runner.js";
import { rowNeedsWrites } from "../src/runners/endpoint/rows.js";
import { JOURNEY_ENDPOINT_SPECS } from "../src/runners/endpoint/specs-journeys.js";
import { RECEIVER_ENDPOINT_SPECS } from "../src/runners/endpoint/specs-receiver.js";
import { VECTORS } from "../src/vectors/index.js";
import { DERIVED_VECTOR_IDS } from "../src/vectors/receiver.js";

const specs = { ...EARLIER_ENDPOINT_SPECS, ...RECEIVER_ENDPOINT_SPECS, ...JOURNEY_ENDPOINT_SPECS };

describe("the endpoint spec tables", () => {
  it("name only ids that are in the catalogue, for the receiver vectors, and give every REC vector its rows", () => {
    const ids = new Set(VECTORS.map((vector) => vector.id));
    for (const id of Object.keys(RECEIVER_ENDPOINT_SPECS)) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const vector of VECTORS.filter((entry) => entry.class === "receiver" && !DERIVED_VECTOR_IDS.includes(entry.id))) {
      expect(RECEIVER_ENDPOINT_SPECS[vector.id]?.rows.length ?? 0, vector.id).toBeGreaterThan(0);
    }
    for (const id of DERIVED_VECTOR_IDS) {
      expect(specs[id], id).toBeUndefined();
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("keep row ids unique within a vector and give every row a request or a procedure", () => {
    for (const [id, spec] of Object.entries(specs)) {
      const names = spec.rows.map((row) => row.id);
      expect(new Set(names).size, `${id} row ids`).toBe(names.length);
      for (const row of spec.rows) {
        expect(row.requests.length > 0 || row.procedure !== undefined || row.manual !== undefined, `${id}/${row.id}`).toBe(true);
      }
    }
  });

  it("send only a check, a submission, raw bytes or a GET of the definition: no verb outside GET and POST", () => {
    for (const [id, spec] of Object.entries(specs)) {
      for (const row of spec.rows) {
        for (const request of row.requests) {
          expect(["check", "submit", "raw", "get"], `${id}/${row.id}`).toContain(request.kind);
          if (request.kind === "raw") {
            expect([undefined, "POST", "GET"], `${id}/${row.id}`).toContain(request.method);
          }
        }
      }
    }
  });

  it("mark every submission row as a write, and every digest row as comparing against the delivered document", () => {
    for (const [id, spec] of Object.entries(specs)) {
      for (const row of spec.rows) {
        const submits = row.requests.some((request) => request.kind === "submit" || (request.kind === "raw" && request.route === "submit"));
        expect(rowNeedsWrites(row), `${id}/${row.id}`).toBe(submits);
        if (row.digestOfSent === true) {
          expect(JSON.stringify(row.expect), `${id}/${row.id}`).toContain('"golden":"sent"');
        }
      }
    }
  });

  it("run a vector's own input against an endpoint only when that vector is over the base form (a spec's rows are self-contained)", () => {
    for (const vector of VECTORS.filter((entry) => runsOnEndpoint(entry) && specs[entry.id] === undefined && !DERIVED_VECTOR_IDS.includes(entry.id))) {
      expect(vector.fixture.definition, vector.id).toBe("base");
      expect(vector.expect, vector.id).toBeDefined();
    }
  });
});
