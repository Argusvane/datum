// Regenerates golden/abi-<major>.<minor>.json from the engine's own kernel, after proving that the
// suite's independent reference (src/reference/canonical.ts: its own serializer, node:crypto
// SHA-256) gives the same canonical text and digest for every document. A disagreement stops the
// write: one of the two is wrong, and a golden file must never be the kernel agreeing with itself.
//   npm run golden:write
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formulaFunctionSignatures, JsonWasmAbi, kernelDocumentDigest, kernelSha256Hex, kernelStableStringify, kernelUtf8Binary, runKernel, WasmValidationHost, WASM_ABI_VERSION } from "@argusvane/datum-engine";

import { baseRoot, BASE_FORM_ID } from "../src/fixtures/base-form.js";
import { CONTROL_VALUES } from "../src/fixtures/controls.js";
import { GOLDEN_DOCUMENT_INPUTS, goldenCaseContext } from "../src/fixtures/golden-inputs.js";
import { errorToken, type Json } from "../src/observation.js";
import { referenceDigest } from "../src/reference/canonical.js";
import { verdictFrom } from "../src/runners/program/session.js";

const signatures = formulaFunctionSignatures();

// The hosts share their canonical cases (integrations/shared/fixtures/canonical.json, written by
// `npm run shared:canonical-fixtures`). They join the golden documents as "shared: <name>" (a neutral prefix: the
// cases belong to no one host, and several names repeat the suite's own) so the suite holds a program to the very
// bytes every host port is held to.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sharedFile = join(repoRoot, "integrations", "shared", "fixtures", "canonical.json");
const sharedInputs = existsSync(sharedFile)
  ? (JSON.parse(readFileSync(sharedFile, "utf8")) as { name: string; input: string; engine: string }[]).map((entry) => ({ name: `shared: ${entry.name}`, input: entry.input, expected: entry.engine }))
  : [];
if (sharedInputs.length === 0) {
  throw new Error(`golden: ${sharedFile} is missing; run npm run shared:canonical-fixtures`);
}

const documents = [...GOLDEN_DOCUMENT_INPUTS.map((entry) => ({ ...entry, expected: undefined as string | undefined })), ...sharedInputs].map(({ name, input, expected }) => {
  const parsed = JSON.parse(input) as unknown;
  const kernel = kernelDocumentDigest(parsed);
  const reference = referenceDigest(parsed);
  if (kernel.canonical !== reference.canonical || kernel.digest !== reference.digest) {
    throw new Error(`golden: the kernel and the independent reference disagree on "${name}"\n  kernel:    ${kernel.canonical}\n  reference: ${reference.canonical}`);
  }
  if (expected !== undefined && expected !== reference.canonical) {
    throw new Error(`golden: the reference disagrees with the shared fixture on "${name}"`);
  }
  return { name, input, canonical: reference.canonical, digest: reference.digest };
});

// The golden case runs over the context as a host sends it: serialized by the ABI (keys sorted), which
// is the order a program sees. engine/tests/golden-fixture.ts runs the same case over the object literal
// (insertion order) and so pins other bytes, the same length; the suite pins what a program returns.
const wireContext = JSON.parse(new JsonWasmAbi().serializeContext(goldenCaseContext() as never, WasmValidationHost.STRICT_POLICY)) as Record<string, unknown>;
const goldenText = kernelStableStringify(runKernel(wireContext as never, [], undefined, signatures));
const goldenCase = { canonicalLength: goldenText.length, canonicalSha256: kernelSha256Hex(kernelUtf8Binary(goldenText)) };

const controls: Record<string, { accepted: boolean; errors: string[]; values?: Json }> = {};
for (const key of ["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06"] as const) {
  const values = CONTROL_VALUES[key]() as Record<string, unknown>;
  const outcome = runKernel({ formId: BASE_FORM_ID, values, locale: "en", form: baseRoot() } as never, [], undefined, signatures);
  const observation = verdictFrom(kernelStableStringify(outcome));
  if (observation.kind !== "verdict") {
    throw new Error(`golden: ${key} did not produce a verdict`);
  }
  controls[key] = {
    accepted: observation.accepted,
    errors: observation.errors.map(errorToken).sort(),
    ...(observation.accepted && observation.values !== undefined ? { values: observation.values } : {})
  };
}

const file = { abi: WASM_ABI_VERSION, goldenCase, documents, controls };
const [major, minor] = WASM_ABI_VERSION.split(".");
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "golden", `abi-${major}.${minor}.json`);
writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
console.log(`golden: wrote ${target} (${documents.length} documents, ${Object.keys(controls).length} controls, golden case ${goldenCase.canonicalLength} bytes)`);
