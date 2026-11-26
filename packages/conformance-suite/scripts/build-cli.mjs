// Bundles the suite into plain ESM Node can run with no TypeScript toolchain:
// dist/index.mjs holds everything (the public API and the command line); dist/cli.mjs is a three-line
// entry that calls it. dist/host-check.mjs is the second command, datum-host-check (src/host-check/main.ts,
// settings in scripts/host-check-bundle.mjs). The engine and the QuickJS singlefile WASM are inlined, so the bundle needs
// no node_modules. One bundle, not two entries: the engine's root pulls in the whole builder, and
// every entry would carry its own copy (2.5 MB each), while splitting makes a chunk per lazy import.
//
// Settings that matter, and why:
//  - no minify, no keepNames: the bundle must not inject `__name` helpers into functions the
//    sandbox program splices as source (`buildSandboxProgram` uses Function.prototype.toString).
//    The CLI never builds a program (it takes --program <file>), but an unminified bundle keeps
//    that guarantee even for a caller of the API.
//  - ignoreAnnotations: the engine package says "sideEffects": false, and esbuild then drops the
//    lazy `init_*()` calls of the engine's import cycles, leaving classes such as JsonWasmAbi
//    undefined at run time when the CLI is bundled.
//  - a createRequire banner for the few CommonJS `require` calls in the QuickJS loader.
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_CHECK_SIZE_BUDGET_BYTES, hostCheckBuildOptions } from "./host-check-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// The bundle carries the whole engine entry, QuickJS's inlined WASM, the golden file and the binding tester's live
// renderer; the budget is held a little above what it weighs, so growth is a decision, not an accident.
const SIZE_BUDGET_BYTES = 3_500_000;

// Built beside the final files and renamed over them (a rename replaces atomically), so a test or a
// pack running at the same moment never finds dist/index.mjs missing.
const staging = join(dist, ".build");
rmSync(join(dist, "chunks"), { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts" },
  outdir: "dist/.build",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  keepNames: false,
  ignoreAnnotations: true,
  // The worker host's thread body is a file beside its package: a single-file bundle cannot carry it, so the
  // program runner reaches it only where the repository is installed and skips the worker rows otherwise.
  external: ["@argusvane/datum-quickjs-wasm-host/worker"],
  metafile: true,
  logLevel: "warning",
  banner: { js: "import { createRequire as __datumCreateRequire } from 'node:module'; const require = __datumCreateRequire(import.meta.url);" }
});

renameSync(join(staging, "index.mjs"), join(dist, "index.mjs"));
rmSync(staging, { recursive: true, force: true });
writeFileSync(
  join(dist, "cli.mjs.new"),
  [
    "// The command line: dist/index.mjs holds the suite (scripts/build-cli.mjs).",
    'import { runCli } from "./index.mjs";',
    "process.exitCode = await runCli(process.argv.slice(2));",
    ""
  ].join("\n")
);

renameSync(join(dist, "cli.mjs.new"), join(dist, "cli.mjs"));

// The second command, datum-host-check (the host conformance kit, src/host-check): a bundle of its own,
// so neither command carries the other's code. Same staging-and-rename as the suite's bundle.
mkdirSync(staging, { recursive: true });
await build(hostCheckBuildOptions(root, "dist/.build/host-check.mjs"));
renameSync(join(staging, "host-check.mjs"), join(dist, "host-check.mjs"));
rmSync(staging, { recursive: true, force: true });

// Two budgets: the security suite's bundles (index.mjs, cli.mjs) and the host check's own.
const HOST_CHECK_FILE = join(dist, "host-check.mjs");
let total = 0;
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "types") walk(path);
    } else if (path.endsWith(".mjs")) {
      files.push(path);
      if (path !== HOST_CHECK_FILE) total += statSync(path).size;
    }
  }
}
walk(dist);

const problems = [];
for (const path of files) {
  const text = readFileSync(path, "utf8");
  if (/\b__name\(/.test(text)) problems.push(`${path} contains an injected __name helper`);
}
if (total > SIZE_BUDGET_BYTES) problems.push(`the bundle is ${total} bytes, over the ${SIZE_BUDGET_BYTES} budget`);
const hostCheckBytes = statSync(HOST_CHECK_FILE).size;
if (hostCheckBytes > HOST_CHECK_SIZE_BUDGET_BYTES) problems.push(`dist/host-check.mjs is ${hostCheckBytes} bytes, over its ${HOST_CHECK_SIZE_BUDGET_BYTES} budget`);
writeFileSync(join(dist, "bundle-size.txt"), `${files.map((path) => `${path.slice(root.length + 1)} ${statSync(path).size}`).join("\n")}\ntotal ${total}\nhost-check ${hostCheckBytes}\n`);
if (problems.length > 0) {
  console.error(`build-cli: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`build-cli: ${files.length} files, ${total} bytes (budget ${SIZE_BUDGET_BYTES}); host-check.mjs ${hostCheckBytes} bytes (budget ${HOST_CHECK_SIZE_BUDGET_BYTES})`);
