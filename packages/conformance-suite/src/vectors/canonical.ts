import { WasmValidationHost, JsonWasmAbi } from "@argusvane/datum-engine";

import { CONTROL_VALUES } from "../fixtures/controls.js";
import { BUNDLED_GOLDEN, goldenCaseContext } from "../fixtures/golden.js";
import { flatValid, parsed } from "../fixtures/inputs.js";
import type { Json } from "../observation.js";
import type { Expectation } from "../predicates.js";
import { accepted, all, any, RUNS, TESTS, vector } from "./helpers.js";
import type { PluginSource, Variant, Vector, VectorInput } from "./schema.js";

/**
 * CAN: canonical text and digest. A run that is sent a `document` answers its canonical text and
 * SHA-256; both are pinned to a golden file written by an independent serializer (not the
 * kernel), so a program that drifts (a number format, a key order, a surrogate) is caught even
 * when it agrees with itself.
 */
const everywhere = { program: RUNS, endpoint: false, parity: RUNS } as const;
const DIGEST_TESTS = [{ path: "packages/quickjs-wasm-host/tests/sandbox-digest-index.test.ts" }, { path: "packages/submissions/tests/kernel-digest.test.ts" }];

/** The golden case as the host sends it: the serialized context, so the bytes are the ABI's. */
const GOLDEN_CASE_TEXT = new JsonWasmAbi().serializeContext(goldenCaseContext() as never, WasmValidationHost.STRICT_POLICY);
const goldenCaseRun = (): VectorInput => ({ kind: "raw", route: "validate", body: GOLDEN_CASE_TEXT });

const documents = BUNDLED_GOLDEN.documents;
const documentOf = (name: string): Json => {
  const found = documents.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`the golden file has no document ${name}`);
  }
  return parsed(found.input);
};

const withDocument = (name: string, values: Json = CONTROL_VALUES["CTL-01"]()): VectorInput => ({ kind: "values", values, document: documentOf(name) });
const pinned = (name: string): Expectation => all({ op: "canonicalEquals", golden: name }, { op: "digestEquals", golden: name }, { op: "custom", name: "digest-is-sha256-of-canonical" });

const documentVariants: Variant[] = documents.slice(1).map((entry) => ({ id: entry.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), input: withDocument(entry.name), expect: pinned(entry.name) }));

const mutatingPlugin: PluginSource = {
  id: "can-03",
  version: "1.0.0",
  source: `({ validators: [ function (c) { try { c.values.name = "mutated"; c.values.extra = 1; if (c.document) { c.document.B = 99; c.document.added = true; } if (c.form) { c.form.id = "mutated"; } } catch (error) {} return { errors: [] }; } ] })`
};

const noDocument: Expectation = all({ op: "rawAt", path: "digest", absent: true }, { op: "rawAt", path: "canonical", absent: true });
const hasDocument = (name: string): Expectation => all({ op: "rawAt", path: "digest" }, { op: "rawAt", path: "canonical" }, pinned(name));

export const CANONICAL_VECTORS: Vector[] = [
  vector({
    id: "CAN-01",
    title: "The golden case (60 rows, a container, many error kinds, the fold report, a document) comes back as exactly the pinned bytes",
    class: "canonical",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [{ path: TESTS.kernelLimits, name: "the kernel's dictionaries are records of their own" }] },
    input: goldenCaseRun(),
    expect: { op: "goldenCase" },
    applies: everywhere
  }),
  vector({
    id: "CAN-02",
    title: "Adversarial documents (1e21, -0, 2^53+1, integer-like keys, __proto__, U+2028, lone surrogates, astral keys) get the pinned canonical text and digest",
    class: "canonical",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [...DIGEST_TESTS] },
    input: withDocument(documents[0]?.name ?? "numbers"),
    expect: pinned(documents[0]?.name ?? "numbers"),
    variants: documentVariants,
    applies: everywhere
  }),
  vector({
    id: "CAN-03",
    title: "A validator that rewrites the values, the document or the form cannot change the digest: it is the digest of the document as sent",
    class: "canonical",
    severity: "S3",
    attacker: "plugin-author",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/sandbox-digest-index.test.ts", name: "names the document as sent alike when a validator rewrites it or throws" }] },
    fixture: { definition: "base", plugins: [mutatingPlugin] },
    input: withDocument("case"),
    expect: pinned("case")
  }),
  vector({
    id: "CAN-04",
    title: "canonical and digest come back exactly when a document was sent, whatever the verdict",
    class: "canonical",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [{ path: "packages/quickjs-wasm-host/tests/sandbox-digest-index.test.ts" }] },
    input: withDocument("case"),
    expect: all(accepted(true), hasDocument("case")),
    variants: [
      { id: "rejected-run-still-digests", input: withDocument("case", CONTROL_VALUES["CTL-02"]()), expect: all(accepted(false), hasDocument("case")) },
      { id: "no-document-no-digest", input: { kind: "values", values: CONTROL_VALUES["CTL-01"]() }, expect: all(accepted(true), noDocument) },
      { id: "rejected-without-document", input: { kind: "values", values: CONTROL_VALUES["CTL-02"]() }, expect: all(accepted(false), noDocument) }
    ]
  }),
  vector({
    id: "CAN-05",
    title: "The same run twice, and a reused sandbox after three other forms, give byte-identical outcomes",
    class: "canonical",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [] },
    input: { kind: "series", steps: [goldenCaseRun(), goldenCaseRun()] },
    expect: { op: "goldenCase" },
    variants: [
      {
        id: "after-three-other-runs",
        input: {
          kind: "series",
          steps: [
            goldenCaseRun(),
            { kind: "values", values: CONTROL_VALUES["CTL-01"]() },
            { kind: "values", values: CONTROL_VALUES["CTL-02"]() },
            { kind: "values", values: CONTROL_VALUES["CTL-06"]() },
            goldenCaseRun()
          ]
        }
      }
    ],
    applies: everywhere
  }),
  vector({
    id: "CAN-06",
    title: "A stored record's digest is the independent digest of the delivered document: floats (0.1, 1/3, 1e21, 1e-7) survive the host's JSON round trip",
    class: "canonical",
    severity: "S3",
    attacker: "network",
    provenance: { tests: [] },
    input: {
      kind: "values",
      values: { ...flatValid({ "rows[0].sku": "s0", "rows[0].n": 0.1 }), "rows[1].sku": "s1", "rows[1].n": 1 / 3, "rows[2].sku": "s2", "rows[2].n": 1e21, "rows[3].sku": "s3", "rows[3].n": 1e-7 }
    },
    expect: accepted(true),
    // Endpoint only, and only with --allow-writes: the digest comes back on a stored record. The row is in runners/endpoint/applicability.ts.
    applies: { program: false, endpoint: { needsWrites: true, note: "the stored record's digest is compared with the reference digest of the document sent" }, parity: false }
  }),
  vector({
    id: "CAN-07",
    title: "A lone surrogate or NUL in an unknown key does not crash the program (the PHP receiver refuses such a body; the difference is logged, not failed)",
    class: "canonical",
    severity: "S4",
    attacker: "network",
    provenance: { tests: [] },
    gate: { status: "advisory" },
    input: { kind: "values", values: parsed(`${JSON.stringify(flatValid()).slice(0, -1)},"\\ud800":"lone","\\u0000":"nul"}`) },
    expect: any(accepted(true), accepted(false)),
    applies: { program: RUNS, endpoint: false, parity: false }
  })
];
