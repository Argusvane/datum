/**
 * Coverage of the form's rules by its scenarios. The module lives in the
 * engine (`@argusvane/datum-engine/logic`, `builder/logic/coverage.ts`) so the builder's Tests
 * panel reads pins from the same code; this file keeps the package's names. The command line
 * and the vitest helper count a scenario that ran (the engine's default reach, "ran").
 */
import type { CoverageOf } from "./api.js";
import { COVERABLE_KINDS, coverageOf as engineCoverageOf, coversRule, pathReaderOf, type PathReader } from "@argusvane/datum-engine/logic";

export { COVERABLE_KINDS, coversRule, pathReaderOf };
export type { PathReader };

export const coverageOf: CoverageOf = (definition, scenarios) => engineCoverageOf(definition, scenarios, { reach: "ran" });
