// Bundles datum-form-test into plain ESM Node 22 runs with no TypeScript toolchain and no
// node_modules (the conformance suite's shape):
//  - dist/index.mjs: the package's API and the command, with the engine and QuickJS inlined;
//  - dist/cli.mjs: the three-line entry bin/datum-form-test.mjs imports;
//  - dist/vitest.mjs: the vitest helper, `vitest` external and everything else from ./index.mjs, so
//    a project using both entries loads the engine once.
// The settings (and why) are in scripts/bundle-options.mjs, which tests/bundle.test.ts builds with too.
//
// Sizes: the package build makes index.mjs 3,176,222 bytes (the
// engine root, the Logic model through @argusvane/datum-engine/logic and QuickJS's inlined WASM), under the
// 4,000,000-byte budget; vitest.mjs 7,641 bytes, under 100,000; cli.mjs 170. A budget is raised only for a
// named growth, recorded here.
import { build } from "esbuild";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_ENTRY, INDEX_BUDGET_BYTES, VITEST_BUDGET_BYTES, indexBuildOptions, vitestBuildOptions } from "./bundle-options.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// Built beside the final files and renamed over them (a rename replaces atomically), so a test or a
// pack running at the same moment never finds dist/index.mjs missing.
const staging = join(dist, ".build");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

await build(indexBuildOptions(root, join(staging, "index.mjs")));
await build(vitestBuildOptions(root, join(staging, "vitest.mjs")));
writeFileSync(join(staging, "cli.mjs"), CLI_ENTRY);

for (const name of ["index.mjs", "vitest.mjs", "cli.mjs"]) {
  renameSync(join(staging, name), join(dist, name));
}
rmSync(staging, { recursive: true, force: true });

const files = ["index.mjs", "vitest.mjs", "cli.mjs"].map((name) => join(dist, name));
const problems = [];
for (const path of files) {
  const text = readFileSync(path, "utf8");
  if (/\b__name\(/.test(text)) problems.push(`${path} contains an injected __name helper`);
}
const sizeOf = (name) => statSync(join(dist, name)).size;
const indexBytes = sizeOf("index.mjs");
const vitestBytes = sizeOf("vitest.mjs");
if (indexBytes > INDEX_BUDGET_BYTES) problems.push(`dist/index.mjs is ${indexBytes} bytes, over its ${INDEX_BUDGET_BYTES} budget`);
if (vitestBytes > VITEST_BUDGET_BYTES) problems.push(`dist/vitest.mjs is ${vitestBytes} bytes, over its ${VITEST_BUDGET_BYTES} budget`);
writeFileSync(join(dist, "bundle-size.txt"), `${files.map((path) => `${path.slice(root.length + 1)} ${statSync(path).size}`).join("\n")}\n`);
if (problems.length > 0) {
  console.error(`build-cli: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`build-cli: index.mjs ${indexBytes} bytes (budget ${INDEX_BUDGET_BYTES}); vitest.mjs ${vitestBytes} bytes (budget ${VITEST_BUDGET_BYTES}); cli.mjs ${sizeOf("cli.mjs")} bytes`);
