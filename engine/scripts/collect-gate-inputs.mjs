import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Runs every real release-gate check (cross-runtime parity, a render
// perf micro-benchmark, and the security isolation checks) and writes the assembled
// ReleaseGateInput to gate-inputs.json. Requires `npm run build` first.
const { collectReleaseGateInputs } = await import("../dist/form-engine/verification/gate-inputs.js");

const input = await collectReleaseGateInputs();
const outputPath = join(process.cwd(), "gate-inputs.json");
writeFileSync(outputPath, `${JSON.stringify(input, null, 2)}\n`);

console.log(`Wrote ${outputPath}`);
console.log(JSON.stringify(input, null, 2));
