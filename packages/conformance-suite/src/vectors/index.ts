import { ABI_VECTORS } from "./abi.js";
import { BUILDER_VECTORS } from "./builder.js";
import { DEFINITION_VECTORS } from "./definition.js";
import { CONTROL_VECTORS } from "./controls.js";
import { ISOLATION_VECTORS } from "./isolation.js";
import { JOURNEY_VECTORS } from "./journeys.js";
import { OUTPUT_VECTORS } from "./output.js";
import { PARITY_VECTORS } from "./parity.js";
import { PROGRAM_PACK_VECTORS } from "./program-packs.js";
import { RECEIVER_VECTORS } from "./receiver.js";
import { TEST_VECTORS } from "./tests.js";
import type { Vector, VectorClass } from "./schema.js";

/** Every vector, in report order. Ids are stable forever and never reused. */
export const VECTORS: readonly Vector[] = [...CONTROL_VECTORS, ...ABI_VECTORS, ...ISOLATION_VECTORS, ...PROGRAM_PACK_VECTORS, ...DEFINITION_VECTORS, ...BUILDER_VECTORS, ...RECEIVER_VECTORS, ...JOURNEY_VECTORS, ...PARITY_VECTORS, ...OUTPUT_VECTORS, ...TEST_VECTORS];

export function vectorById(id: string): Vector | undefined {
  return VECTORS.find((vector) => vector.id === id);
}

const CLASS_PREFIX: Record<VectorClass, string> = {
  control: "CTL",
  abi: "ABI",
  isolation: "ISO",
  resource: "RES",
  options: "OPT",
  files: "FIL",
  context: "CTX",
  canonical: "CAN",
  receiver: "REC",
  secrecy: "SEC",
  parity: "PAR",
  definition: "DEF",
  builder: "BLD",
  output: "OUT",
  journey: "JRN",
  test: "TST"
};

/**
 * A `--only` / `--skip` selector: a vector id (`ISO-03`), a class name (`isolation`) or a class
 * prefix (`ISO`). Case-insensitive.
 */
export function matchesSelector(vector: Vector, selector: string): boolean {
  const wanted = selector.trim().toLowerCase();
  return vector.id.toLowerCase() === wanted || vector.class === wanted || CLASS_PREFIX[vector.class].toLowerCase() === wanted;
}

export function knownSelector(selector: string): boolean {
  const wanted = selector.trim().toLowerCase();
  return VECTORS.some((vector) => matchesSelector(vector, wanted));
}
