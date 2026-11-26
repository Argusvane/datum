import { RECEIVER_ENDPOINT_SPECS } from "../runners/endpoint/specs-receiver.js";
import { LEAK_MARKERS } from "../runners/endpoint/wire.js";
import { vector } from "./helpers.js";
import type { Attacker, Gate, Severity, Variant, Vector } from "./schema.js";

/**
 * REC: the receiver and HTTP contract; SEC-05: the wire hygiene rule. These run against an
 * endpoint only (`applies.program` is false); the requests live in `src/runners/endpoint/`
 * (`specs-receiver.ts`) because they need the profile's wire, and the variants listed here are
 * the same rows by id so `explain` and the report show what each one sends and expects.
 *
 * REC-14, REC-16 and SEC-05 are DERIVED rows: no request of their own. SEC-05 judges every response of
 * the run (never a 5xx other than a typed 503, JSON bodies of the contract's shape, no stack
 * trace or host path); REC-14 judges any 429 the run happened to meet and is never provoked; REC-16 does the same for a 503.
 */
const TESTS = {
  hardening: "packages/submissions/tests/service-hardening.test.ts",
  http: "packages/submissions/src/http-mapping.ts"
} as const;

const placeholder = { kind: "raw", route: "validate", body: "" } as const;

/** The variants of a vector, from its endpoint rows (what the row sends is in the spec, which `explain` points at). */
function variantsOf(id: string): Variant[] {
  return (RECEIVER_ENDPOINT_SPECS[id]?.rows ?? []).map((row) => ({ id: row.id, input: placeholder, expect: row.expect }));
}

function receiver(options: {
  id: string;
  title: string;
  severity?: Severity;
  attacker?: Attacker;
  gate?: Gate;
  tests?: { path: string; name?: string }[];
}): Vector {
  const spec = RECEIVER_ENDPOINT_SPECS[options.id];
  const first = spec?.rows[0];
  return vector({
    id: options.id,
    title: options.title,
    class: "receiver",
    severity: options.severity ?? "S3",
    attacker: options.attacker ?? "filler",
    provenance: { tests: options.tests ?? [] },
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    input: placeholder,
    expect: first?.expect ?? { op: "custom", name: "no-server-failure" },
    ...((spec?.rows.length ?? 0) > 1 || first?.id !== "(base)" ? { variants: variantsOf(options.id) } : {}),
    applies: { program: false, endpoint: spec?.heavy === true ? { heavy: true } : {}, parity: false }
  });
}

export const RECEIVER_VECTORS: Vector[] = [
  receiver({ id: "REC-01", title: "A body that is not a JSON object (empty, truncated, a scalar, invalid UTF-8) is refused 400 bad_document" }),
  receiver({ id: "REC-02", title: "A number JSON cannot hold (1e999) is refused 400 bad_document, never a 5xx" }),
  receiver({ id: "REC-03", title: "A body over the limit is refused 413 bad_document" }),
  receiver({ id: "REC-04", title: "Values nested past the depth limit are refused 400 bad_document, never a 5xx" }),
  receiver({ id: "REC-05", title: "A body for another form, without values, with a bad scope or page, or a check sent as a submission is refused 400 bad_document", tests: [{ path: TESTS.hardening }] }),
  receiver({ id: "REC-06", title: "A document for another or older form version is refused 409 (form.outdated, version_superseded)", tests: [{ path: TESTS.hardening, name: "judges only the current version" }] }),
  receiver({ id: "REC-07", title: "A locale that is not a short language tag is refused 400 bad_document on submit and never breaks a check", tests: [{ path: TESTS.hardening, name: "holds a locale" }] }),
  receiver({ id: "REC-08", title: "A signed wrapper holds only format, payload and signatures: a sibling member or a missing part is refused 400 bad_document", tests: [{ path: TESTS.hardening, name: "refuses unknown siblings" }] }),
  receiver({ id: "REC-09", title: "An unknown journey is a typed rejection (journey.unknown), on a check and on a submission" }),
  receiver({ id: "REC-10", title: "An unknown form, a GET on the check route, text/plain or no content type are refused with a 4xx, never a 5xx", severity: "S4", attacker: "network" }),
  receiver({ id: "REC-11", title: "Hostile keys (__proto__, constructor, toString) on the wire give a verdict and echo nothing", severity: "S2" }),
  receiver({
    id: "REC-12",
    title:
      "A delivery is one submission by its submissionKey: the same key and document twice is the first record (the same id), never a second record and never refused; the same key with another document is refused 409 submission.keyConflict; no key is refused 400; two keys with the same answers are two records",
    attacker: "network",
    tests: [{ path: TESTS.hardening, name: "replay" }]
  }),
  receiver({ id: "REC-13", title: "A check stores nothing: the form's record count is the same after it", tests: [{ path: TESTS.http }] }),
  vector({
    id: "REC-14",
    title: "A 429 carries a JSON body with the code flood (judged only when the run met one; never provoked)",
    class: "receiver",
    severity: "S4",
    attacker: "network",
    provenance: { tests: [] },
    gate: { status: "advisory" },
    input: placeholder,
    expect: { op: "refusal", anyOf: ["rate_limited"], codes: ["flood"] },
    applies: { program: false, endpoint: { note: "derived: judged over any 429 the run met" }, parity: false }
  }),
  vector({
    id: "REC-16",
    title: "A 503 carries a JSON body with a typed code (server.busy, server.unavailable, validator_unavailable, data_source.unavailable, or a failed run: wasm.execution_error, outcome_too_large, definition.tooDeep); judged only when the run met one, never provoked",
    class: "receiver",
    severity: "S4",
    attacker: "network",
    provenance: { tests: [] },
    gate: { status: "advisory" },
    input: placeholder,
    expect: { op: "refusal", anyOf: ["unavailable"], codes: ["server.busy", "server.unavailable", "validator_unavailable", "data_source.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep"] },
    applies: { program: false, endpoint: { note: "derived: judged over any 503 the run met (a saturated sandbox answers 503 server.busy with Retry-After; a run that failed answers 503 with its own code and no Retry-After; the suite never saturates one)" }, parity: false }
  }),
  vector({
    id: "SEC-05",
    title: "Over every response: no 5xx other than a typed 503, bodies are JSON of the contract's shape, and no stack trace, host path or secret marker",
    class: "secrecy",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [] },
    input: placeholder,
    expect: { op: "textExcludes", markers: [...LEAK_MARKERS] },
    applies: { program: false, endpoint: { note: "derived: judged over every response of the run" }, parity: false }
  })
];

/** The vectors that have no request of their own: the endpoint runner judges them over the whole run's exchanges. */
export const DERIVED_VECTOR_IDS: readonly string[] = ["REC-14", "REC-16", "SEC-05"];
