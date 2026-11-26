import abi41 from "../../golden/abi-4.1.json" with { type: "json" };
import type { GoldenControl } from "../predicates.js";

/** The pinned reference file for the sandbox ABI (`golden/abi-4.1.json`). */
export interface GoldenFile {
  abi: string;
  goldenCase: { canonicalLength: number; canonicalSha256: string };
  documents: { name: string; input: string; canonical: string; digest: string }[];
  controls: Record<string, GoldenControl>;
}

/** The `major.minor` of the ABI the bundled golden file pins. */
export const BUNDLED_GOLDEN_ABI = "4.1";

/** The golden file the bundle carries: the current ABI's. `--golden <file>` overrides. */
export const BUNDLED_GOLDEN: GoldenFile = abi41 as unknown as GoldenFile;

export interface GoldenChoice {
  golden: GoldenFile;
  /** The `major.minor` of the file used. */
  file: string;
  /** Why the program is judged against a golden file of another ABI, when it is. */
  warning?: string;
}

/**
 * The golden file a program is judged against: the bundled one, which pins the current ABI. A
 * program whose ABI is unknown or of another `major.minor` is judged against it all the same, with
 * a warning; the ABI rows fail such a program on their own.
 */
export function chooseGolden(detectedAbi: string | undefined): GoldenChoice {
  const choice = { golden: BUNDLED_GOLDEN, file: BUNDLED_GOLDEN_ABI };
  if (detectedAbi === undefined) {
    return { ...choice, warning: `the program's ABI is unknown; judged against the golden file of ABI ${BUNDLED_GOLDEN_ABI}` };
  }
  const wanted = detectedAbi.split(".").slice(0, 2).join(".");
  return wanted === BUNDLED_GOLDEN_ABI ? choice : { ...choice, warning: `the program answers ABI ${detectedAbi}; the golden file pins ABI ${BUNDLED_GOLDEN_ABI}` };
}

export { GOLDEN_DOCUMENT_INPUTS, goldenCaseContext } from "./golden-inputs.js";
