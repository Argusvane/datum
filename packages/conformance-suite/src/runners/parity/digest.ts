import { canonicalizeSubmission, JsonWasmAbi, kernelDocumentDigest, sha256, WasmValidationHost } from "@argusvane/datum-engine";

import { BASE_FORM_ID, baseRoot } from "../../fixtures/base-form.js";
import type { GoldenFile } from "../../fixtures/golden.js";
import { referenceDigest } from "../../reference/canonical.js";
import { ProgramSession } from "../program/session.js";

export type DigestSource = "golden" | "reference" | "kernel" | "submissions" | "program";

export interface DigestRow {
  /** The document's name in the golden file (`numbers`, `shared: ...`). */
  name: string;
  canonical: Partial<Record<DigestSource, string>>;
  digest: Partial<Record<DigestSource, string>>;
  /** The sources that disagree with the golden file (or are missing), empty when all agree. */
  disagree: DigestSource[];
}

/**
 * What `@argusvane/datum-submissions` `submissionDigest` computes: SHA-256 over `JSON.stringify` of the
 * engine's `canonicalizeSubmission`. Mirrored here because the submissions package is not a
 * dependency of the suite (it would pull the PDF stack into the bundle); a test holds this to the
 * real function.
 */
export function submissionDigestOf(document: unknown): { canonical: string; digest: string } {
  const canonical = JSON.stringify(canonicalizeSubmission(document as never));
  let digest = "";
  for (const byte of sha256(new TextEncoder().encode(canonical))) {
    digest += byte.toString(16).padStart(2, "0");
  }
  return { canonical, digest };
}

/** What the program says about one document: the canonical text and digest of an outcome that was sent a `document`. */
export async function programDigestOf(session: ProgramSession, document: unknown): Promise<{ canonical?: string; digest?: string; problem?: string }> {
  const context = { formId: BASE_FORM_ID, values: {}, locale: "en", form: baseRoot(), document };
  const run = await session.run(new JsonWasmAbi().serializeContext(context as never, WasmValidationHost.STRICT_POLICY));
  if (run.observation.kind !== "verdict") {
    return { problem: `the program gave no verdict (${run.observation.kind})` };
  }
  return {
    ...(run.observation.canonical !== undefined ? { canonical: run.observation.canonical } : {}),
    ...(run.observation.digest !== undefined ? { digest: run.observation.digest } : {})
  };
}

/**
 * PAR-05: for each document of the CAN-02 corpus (the golden file's documents), the canonical text
 * and SHA-256 from the golden file, the suite's independent reference, the in-process kernel, the
 * submissions package's digest, and the program must be one value. Rows list who disagreed.
 */
export async function digestParity(golden: GoldenFile, session: ProgramSession): Promise<DigestRow[]> {
  const rows: DigestRow[] = [];
  for (const entry of golden.documents) {
    // A macrotask turn between documents: see breathe() in parity-runner.ts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const parsed = JSON.parse(entry.input) as unknown;
    const reference = referenceDigest(parsed);
    const kernel = kernelDocumentDigest(parsed);
    const submissions = submissionDigestOf(parsed);
    const program = await programDigestOf(session, parsed);
    const canonical: DigestRow["canonical"] = { golden: entry.canonical, reference: reference.canonical, kernel: kernel.canonical, submissions: submissions.canonical };
    const digest: DigestRow["digest"] = { golden: entry.digest, reference: reference.digest, kernel: kernel.digest, submissions: submissions.digest };
    if (program.canonical !== undefined) {
      canonical.program = program.canonical;
    }
    if (program.digest !== undefined) {
      digest.program = program.digest;
    }
    const disagree = (["reference", "kernel", "submissions", "program"] as const).filter((source) => canonical[source] !== entry.canonical || digest[source] !== entry.digest);
    rows.push({ name: entry.name, canonical, digest, disagree });
  }
  return rows;
}
