import { BUILDER_SPECS } from "../runners/endpoint/profiles/builder-specs.js";
import type { Expectation } from "../predicates.js";
import { vector } from "./helpers.js";
import type { Attacker, Severity, Variant, Vector } from "./schema.js";

/**
 * BLD: a host's definition-saving endpoint. The builder profile creates a form of its
 * own (`secsuite_<8 hex>`), saves hostile definitions into it, reads the stored form back, runs the
 * chained check and deletes it again. These vectors run against an endpoint only
 * (`applies.program` is false); the requests live in `src/runners/endpoint/profiles/builder-specs.ts`
 * (a save needs the host's wire) and the variants listed here are the same rows by id, so `explain`
 * and the report show what each one sends and expects.
 *
 * BLD-04, BLD-09, BLD-10 and BLD-11 are DERIVED rows: they judge what the whole run did (every
 * refused save left the form as it was; every accepted hostile save still judges; the cleanup
 * completed; an adopted form was restored).
 */
const placeholder = { kind: "values", values: {} } as const;

const variantsOf = (id: string): Variant[] => (BUILDER_SPECS[id]?.rows ?? []).map((row) => ({ id: row.id, input: placeholder, expect: row.expect }));

function builder(options: { id: string; title: string; severity: Severity; attacker: Attacker; expect?: Expectation; heavy?: boolean; derived?: boolean; adoptOnly?: boolean }): Vector {
  const spec = BUILDER_SPECS[options.id];
  const first = spec?.rows[0];
  const variants = options.derived === true ? [] : variantsOf(options.id).slice(1);
  return vector({
    id: options.id,
    title: options.title,
    class: "builder",
    severity: options.severity,
    attacker: options.attacker,
    provenance: { tests: [] },
    input: placeholder,
    expect: options.expect ?? first?.expect ?? { op: "custom", name: "builder-never-5xx" },
    ...(variants.length > 0 ? { variants } : {}),
    applies: { program: false, endpoint: { profiles: ["builder"], needsWrites: true, ...(options.heavy === true || spec?.heavy === true ? { heavy: true } : {}) }, parity: false }
  });
}

export const BUILDER_VECTORS: Vector[] = [
  builder({ id: "BLD-04", title: "After every refused or failed save the stored definition and its hash are the ones from before", severity: "S3", attacker: "author", derived: true, expect: { op: "custom", name: "atomic-save" } }),
  builder({ id: "BLD-05", title: "A body one byte over the host's definition limit is refused 413", severity: "S3", attacker: "author", heavy: true }),
  builder({ id: "BLD-06", title: "Empty, malformed, BOM, invalid UTF-8, too-deep, out-of-range and duplicate-key bodies, a NUL in an id and hostile locale headers are refused as the client's mistake (never 5xx) and store nothing", severity: "S2", attacker: "author" }),
  builder({ id: "BLD-07", title: "Saving the base fixture twice gives the same hash, the read-back equals the answer, and an unknown top-level key is kept or reported", severity: "S3", attacker: "author" }),
  builder({ id: "BLD-08", title: "The anonymous copy of a saved form holds no server-secret rule and keeps the decoys; the author copy keeps the rules", severity: "S3", attacker: "filler" }),
  builder({
    id: "BLD-09",
    title: "After each accepted hostile save the chained check still answers a typed verdict (or a typed 503), never a server error; and a definition the judge cannot run is refused at save, not later",
    severity: "S2",
    attacker: "filler",
    derived: true,
    expect: { op: "custom", name: "builder-never-5xx" }
  }),
  builder({ id: "BLD-10", title: "The suite form is gone after the run: it is no longer there; an incomplete cleanup is reported with the remedy and the run is INCONCLUSIVE", severity: "S4", attacker: "host-config", derived: true, expect: { op: "custom", name: "builder-never-5xx" } }),
  builder({ id: "BLD-11", title: "An adopted form's stored definition is the one it had before the run", severity: "S4", attacker: "host-config", derived: true, expect: { op: "custom", name: "builder-never-5xx" } })
];
