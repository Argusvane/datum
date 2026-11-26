import type { Expectation } from "../predicates.js";
import { all, TESTS, vector } from "./helpers.js";
import type { Variant, Vector } from "./schema.js";

/**
 * ABI: what the program says about itself. `__datum_inspect` is the only way to read a program's
 * own ABI (it refuses a request of another major or a higher minor), so detection and the floor
 * check both go through it. The tokens `$floor`, `$detected`, `$nextMinor`, `$nextMajor` and
 * `$priorMajor` are filled in by the runner from the run's configuration and the detection.
 */
const PROBE_DEFINITION = { id: "abi-probe", root: { id: "root", type: "form", configuration: {}, children: { content: [] } } };
const provenance = { tests: [{ path: TESTS.inspect }] };

const refused = (code: "abi_mismatch" | "invalid_request"): Expectation =>
  all({ op: "answerPath", path: "ok", equals: false }, { op: "answerPath", path: "error.code", equals: code });

const withAbi = (abi: unknown): { kind: "inspect"; request: unknown } => ({ kind: "inspect", request: { abi, op: "public", definition: PROBE_DEFINITION } });

const mismatch = (id: string, abi: unknown): Variant => ({ id, input: withAbi(abi) });

export const ABI_VECTORS: Vector[] = [
  vector({
    id: "ABI-01",
    title: "The program answers an inspect request at the suite's ABI floor",
    class: "abi",
    severity: "S3",
    attacker: "host-config",
    provenance,
    input: withAbi("$floor"),
    expect: { op: "answerPath", path: "ok", equals: true }
  }),
  vector({
    id: "ABI-02",
    title: "The program's own ABI is at the floor, matches the manifest, and other majors are refused",
    class: "abi",
    severity: "S3",
    attacker: "host-config",
    provenance: { tests: [] },
    input: { kind: "detect-abi" },
    expect: { op: "custom", name: "abi-detection" }
  }),
  vector({
    id: "ABI-03",
    title: "A newer minor, a newer major and an older major are refused with abi_mismatch, not thrown",
    class: "abi",
    severity: "S4",
    attacker: "network",
    provenance,
    input: withAbi("$nextMinor"),
    expect: refused("abi_mismatch"),
    variants: [mismatch("major-next", "$nextMajor"), mismatch("major-prior", "$priorMajor")]
  }),
  vector({
    id: "ABI-04",
    title: "A request whose abi is missing, a number, empty, malformed or null is refused with abi_mismatch",
    class: "abi",
    severity: "S4",
    attacker: "network",
    provenance: { tests: [] },
    input: { kind: "inspect", request: { op: "public", definition: PROBE_DEFINITION } },
    expect: refused("abi_mismatch"),
    variants: [mismatch("number", 2), mismatch("empty", ""), mismatch("malformed", "2.x"), mismatch("null", null)]
  }),
  vector({
    id: "ABI-05",
    title: "A request of no usable shape is refused with invalid_request, not thrown",
    class: "abi",
    severity: "S4",
    attacker: "network",
    provenance,
    input: { kind: "inspect", request: null },
    expect: refused("invalid_request"),
    variants: [
      { id: "array", input: { kind: "inspect", request: [] } },
      { id: "unknown-op", input: { kind: "inspect", request: { abi: "$detected", op: "x", definition: PROBE_DEFINITION } } },
      { id: "no-root", input: { kind: "inspect", request: { abi: "$detected", op: "public", definition: { id: "abi-probe" } } } },
      { id: "root-not-a-record", input: { kind: "inspect", request: { abi: "$detected", op: "public", definition: { id: "abi-probe", root: "form" } } } }
    ]
  })
];
