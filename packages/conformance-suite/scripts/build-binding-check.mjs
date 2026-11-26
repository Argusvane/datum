// Builds the host module of datum-binding-check into binding-check/dist/host.js: the engine renderer,
// its runtime and Datum's binding, from binding-check/host/entry.ts, in one browser ES module the
// published package carries (binding-check/build.mjs serves it). Written beside the final file and
// renamed over it, so a run or a pack at the same moment never finds it half written.
import { build } from "esbuild";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { HOST_BUNDLE, hostBuildOptions } from "../binding-check/build.mjs";

// 1.2 MB, unminified so a stack trace in a case's message names real functions: the live renderer (360 KB),
// the browser runtime (280 KB), expressions, schema, print and the PDF theme ladder, lit-html (15 KB).
const SIZE_BUDGET_BYTES = 1_500_000;

const staging = `${HOST_BUNDLE}.${process.pid}.tmp`;
mkdirSync(dirname(HOST_BUNDLE), { recursive: true });
try {
  await build(hostBuildOptions(staging));
  renameSync(staging, HOST_BUNDLE);
} finally {
  rmSync(staging, { force: true });
}
const bytes = statSync(HOST_BUNDLE).size;
if (bytes > SIZE_BUDGET_BYTES) {
  console.error(`build-binding-check: ${HOST_BUNDLE} is ${bytes} bytes, over its ${SIZE_BUDGET_BYTES} budget`);
  process.exit(1);
}
console.log(`build-binding-check: binding-check/dist/host.js ${bytes} bytes (budget ${SIZE_BUDGET_BYTES})`);
