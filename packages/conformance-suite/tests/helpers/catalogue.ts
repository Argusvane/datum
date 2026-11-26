import { EARLIER_ENDPOINT_SPECS } from "../../src/runners/endpoint/applicability.js";
import { vector } from "../../src/vectors/helpers.js";
import { VECTORS } from "../../src/vectors/index.js";
import type { Vector, VectorClass } from "../../src/vectors/schema.js";

const CLASSES: Record<string, VectorClass> = { CTL: "control", RES: "resource", OPT: "options", FIL: "files", CTX: "context", CAN: "canonical", SEC: "secrecy", REC: "receiver" };

/**
 * The catalogue plus a stub for every endpoint spec whose vector is not registered (yet): the
 * endpoint rows are tested whether or not the program-side vector packs have landed. A stub is
 * a plain enforced S3 vector over the base form whose own expectation is never used.
 */
export function catalogueWithEveryEndpointSpec(): Vector[] {
  const known = new Set(VECTORS.map((entry) => entry.id));
  const stubs = Object.keys(EARLIER_ENDPOINT_SPECS)
    .filter((id) => !known.has(id))
    .map((id) =>
      vector({
        id,
        title: `${id} (stub for the endpoint rows)`,
        class: CLASSES[id.slice(0, 3)] ?? "resource",
        severity: "S3",
        attacker: "filler",
        provenance: { tests: [] },
        input: { kind: "values", values: {} },
        expect: { op: "accepted", value: true },
        applies: { program: false, endpoint: {}, parity: false }
      })
    );
  return [...VECTORS, ...stubs];
}
