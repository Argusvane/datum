import { all, accepted, TESTS, vector } from "./helpers.js";
import type { Vector } from "./schema.js";

/**
 * PAR: parity. These vectors run only in the parity runner (`--parity`); `applies.program` is
 * false so the program runner skips them. A parity vector's own `expect` is never evaluated (the
 * runner compares two runtimes, not one observation against a predicate); it is the placeholder the
 * catalogue shape asks for and says what a pass means. Divergences come from the ledger only
 * (`src/runners/parity/divergences.ts`).
 */
const parityOnly = { program: false, endpoint: false, parity: {} } as const;
const placeholder = all(accepted(true));
const input = { kind: "values", values: {} } as const;
const provenance = (path: string) => ({ tests: [{ path }] });

export const PARITY_VECTORS: Vector[] = [
  vector({
    id: "PAR-01",
    title: "The core validation vectors give identical normalised signatures in the in-process kernel and the program",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: provenance("engine/tests/integration/parity.test.ts"),
    input,
    expect: placeholder,
    applies: parityOnly
  }),
  vector({
    id: "PAR-02",
    title: "The adversarial value vectors give identical normalised signatures in the in-process kernel and the program",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: provenance("engine/form-engine/validation/parity/vectors.ts"),
    input,
    expect: placeholder,
    applies: parityOnly
  }),
  vector({
    id: "PAR-03",
    title: "Every vector that opted into parity gives byte-identical outcome text in the in-process kernel and the program",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: provenance(TESTS.parity),
    input,
    expect: placeholder,
    applies: parityOnly
  }),
  vector({
    id: "PAR-04",
    title: "Curated built-in function calls give the same, pinned value in the in-process kernel and the program",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: provenance("packages/quickjs-wasm-host/tests/sandbox-functions.test.ts"),
    input,
    expect: placeholder,
    applies: parityOnly
  }),
  vector({
    id: "PAR-05",
    title: "Digest parity: golden, independent reference, kernel, submissions package and program agree on canonical text and SHA-256",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: provenance("packages/submissions/tests/kernel-digest.test.ts"),
    input,
    expect: placeholder,
    applies: parityOnly
  }),
  vector({
    id: "PAR-06",
    title: "Endpoint and program agree on the {field, code} set of every vector that runs on both",
    class: "parity",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [] },
    gate: { status: "pending", blockedBy: "the endpoint parity runner" },
    input,
    expect: placeholder,
    applies: parityOnly
  })
];
