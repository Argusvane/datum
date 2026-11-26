import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Reads gate-inputs.json, evaluates the release gates, writes gate-report.json, and exits
// non-zero when any gate fails. Requires `npm run build` first.
const { evaluateReleaseGates } = await import("../dist/form-engine/verification/release-gates.js");

const inputPath = join(process.cwd(), "gate-inputs.json");
if (!existsSync(inputPath)) {
  console.error(`Missing ${inputPath}. Run "npm run gates:collect" first.`);
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const report = evaluateReleaseGates(input);

writeFileSync(
  join(process.cwd(), "gate-report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);

for (const check of report.checks) {
  const status = check.passed ? "PASS" : "FAIL";
  console.log(`[${status}] ${check.name}${check.reason ? ` — ${check.reason}` : ""}`);
}

if (!report.passed) {
  console.error("\nRelease gates FAILED.");
  process.exit(1);
}
console.log("\nAll release gates passed.");
