import { CONTROL_VALUES, CONSTRUCTOR_MARKER, POLLUTION_MARKER, STRAY_MARKER, TOSTRING_MARKER } from "../fixtures/controls.js";
import { accepted, all, RUNS, TESTS, vector } from "./helpers.js";
import type { Vector } from "./schema.js";

/**
 * CTL: controls. A dead or yes-man program must fail these: each one pins a verdict a working
 * kernel gives the fixture form, taken from the golden file (`golden/abi-4.1.json`, reviewed once, not recomputed).
 */
const everywhere = { program: RUNS, endpoint: RUNS, parity: RUNS } as const;
const provenance = { tests: [{ path: TESTS.parity }] };

export const CONTROL_VECTORS: Vector[] = [
  vector({
    id: "CTL-01",
    title: "A valid submission is accepted and its sanitized values are the golden values",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance,
    input: { kind: "values", values: CONTROL_VALUES["CTL-01"]() },
    expect: all(accepted(true), { op: "codes", exactly: [] }, { op: "golden", key: "CTL-01" }),
    applies: everywhere
  }),
  vector({
    id: "CTL-02",
    title: "A blank required field is refused with exactly required@name",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance,
    input: { kind: "values", values: CONTROL_VALUES["CTL-02"]() },
    expect: all(accepted(false), { op: "codes", exactly: ["required@name"] }, { op: "golden", key: "CTL-02" }),
    applies: everywhere
  }),
  vector({
    id: "CTL-03",
    title: "A 41-character name is refused with exactly maxLength@name",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance,
    input: { kind: "values", values: CONTROL_VALUES["CTL-03"]() },
    expect: all(accepted(false), { op: "codes", exactly: ["maxLength@name"] }, { op: "golden", key: "CTL-03" }),
    applies: everywhere
  }),
  vector({
    id: "CTL-04",
    title: "A code that does not match its pattern is refused with exactly pattern@code",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [] },
    input: { kind: "values", values: CONTROL_VALUES["CTL-04"]() },
    expect: all(accepted(false), { op: "codes", exactly: ["pattern@code"] }, { op: "golden", key: "CTL-04" }),
    applies: everywhere
  }),
  vector({
    id: "CTL-05",
    title: "Fields the form does not define (stray, constructor) are stripped from the stored values",
    class: "control",
    severity: "S3",
    attacker: "filler",
    provenance: { tests: [{ path: TESTS.parity, name: "produces byte-identical outcomes for sanitization and constraint cases" }] },
    input: { kind: "values", values: CONTROL_VALUES["CTL-05"]() },
    expect: all(
      accepted(true),
      { op: "valuesExcludeText", text: [STRAY_MARKER, CONSTRUCTOR_MARKER] },
      { op: "golden", key: "CTL-05" }
    ),
    applies: everywhere
  }),
  vector({
    id: "CTL-06",
    title: "Hostile keys (__proto__, constructor, toString) and 10,000 unknown keys neither pollute nor reach the stored values",
    class: "control",
    severity: "S2",
    attacker: "filler",
    provenance: { tests: [{ path: TESTS.parity, name: "treats ids and keys named after Object.prototype members as data" }] },
    input: { kind: "values", values: CONTROL_VALUES["CTL-06"]() },
    expect: all(
      accepted(true),
      { op: "valuesExcludeText", text: [POLLUTION_MARKER, TOSTRING_MARKER] },
      { op: "golden", key: "CTL-06" },
      { op: "custom", name: "no-prototype-pollution" }
    ),
    variants: [
      {
        id: "10k-unknown-keys",
        // 10,000 keys take most of the 250 ms default on an idle machine: a fixed 5 s keeps the check about the keys, not the clock.
        fixture: { definition: "base", hostOptions: { maxEvalMs: 5000 } },
        programOnly: true,
        input: { kind: "values", values: CONTROL_VALUES["CTL-06-bulk"]() },
        expect: all(accepted(true), { op: "valuesExcludeText", text: ["bulk0", "bulk9999"] }, { op: "golden", key: "CTL-01" })
      },
      {
        id: "next-run-is-clean",
        input: {
          kind: "series",
          steps: [
            { kind: "values", values: CONTROL_VALUES["CTL-06"]() },
            { kind: "values", values: CONTROL_VALUES["CTL-01"]() }
          ]
        },
        expect: all(accepted(true), { op: "golden", key: "CTL-01" }, { op: "custom", name: "no-prototype-pollution" })
      }
    ],
    applies: everywhere
  })
];
