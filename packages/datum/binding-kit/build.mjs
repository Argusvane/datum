#!/usr/bin/env node
// Bundles a bindings/<id> package: the binding module as an ES module (`datumBinding.bundle`, what
// `datum-binding-check --binding` and a host's import() take) and as an IIFE
// (`datumBinding.global`, the same name with .iife.js). The build refuses what a binding must not
// carry, and gates the size:
//   - no external imports (a binding is one file),
//   - no lit-html: lit arrives through createBinding(lit, datum),
//   - gzip size of the ES bundle within `datumBinding.budgetKb`.
// Engine code a binding imports for a value (readTypedNumber) is bundled in and reported.
//
//   node binding-kit/build.mjs --binding govuk        (npm run build in the package, kit:build)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { resolveBinding } from "./lib/binding-package.mjs";

function loadEsbuild(pkg) {
  for (const base of [join(pkg.dir, "package.json"), import.meta.url.replace("file://", "")]) {
    try {
      return createRequire(base)("esbuild");
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`esbuild is not installed: run npm install in ${pkg.dir} (esbuild is a devDependency of every binding)`);
}

/** Builds the package. Resolves to `{ outputs, problems, engineBytes }`; writes dist/ unless `write` is false. */
export async function buildBinding(pkg, { write = true } = {}) {
  const problems = [...pkg.problems];
  if (pkg.isDatum) return { outputs: [], problems: ["datum is not a package: it has no bundle to build"], engineBytes: 0 };
  if (!pkg.entry) return { outputs: [], problems: [...problems, "no binding module (src/index.ts or src/binding.ts, or \"binding\" in binding-check.json)"], engineBytes: 0 };
  if (pkg.problems.length > 0) return { outputs: [], problems, engineBytes: 0 };
  const esbuild = loadEsbuild(pkg);
  const outDir = dirname(pkg.bundleFile);
  const stem = pkg.config.bundle.replace(/^.*\//, "").replace(/\.js$/, "");
  if (write) mkdirSync(outDir, { recursive: true });
  const outputs = [];
  let engineBytes = 0;
  for (const [format, name, extra] of [["esm", `${stem}.js`, {}], ["iife", `${stem}.iife.js`, { globalName: pkg.config.global }]]) {
    const result = await esbuild.build({ entryPoints: [pkg.entry], bundle: true, write: false, outfile: join(outDir, name), format, target: "es2022", minify: true, logLevel: "silent", metafile: true, ...extra });
    const bytes = Buffer.from(result.outputFiles[0].contents);
    const text = bytes.toString("utf8");
    const gzip = gzipSync(bytes).length;
    outputs.push({ file: name, bytes: bytes.length, gzip });
    const external = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    if (external.length > 0) problems.push(`${name} imports ${[...new Set(external)].join(", ")}: a binding is one file with no external imports`);
    if (/litHtmlVersions|lit-html/.test(text)) problems.push(`${name} carries lit-html: lit arrives through createBinding(lit, datum), never bundled`);
    if (format === "esm") {
      for (const output of Object.values(result.metafile.outputs)) for (const [path, input] of Object.entries(output.inputs)) if (/(^|\/)engine\//.test(path)) engineBytes += input.bytesInOutput;
      const kb = gzip / 1024;
      if (kb > pkg.config.budgetKb) problems.push(`${name} is ${kb.toFixed(1)} KB gzip, over the budget of ${pkg.config.budgetKb} KB (datumBinding.budgetKb)`);
    }
    if (write) writeFileSync(join(outDir, name), bytes);
  }
  if (write) writeFileSync(join(outDir, "sizes.json"), `${JSON.stringify(outputs, null, 2)}\n`);
  return { outputs, problems, engineBytes };
}

export async function main(argv) {
  const at = argv.indexOf("--binding");
  if (at < 0 || !argv[at + 1]) { console.error("usage: node binding-kit/build.mjs --binding <id | package path>"); return 2; }
  let pkg;
  try { pkg = resolveBinding(argv[at + 1]); } catch (error) { console.error(error.message); return 2; }
  const { outputs, problems, engineBytes } = await buildBinding(pkg);
  for (const o of outputs) console.log(`${o.file.padEnd(18)} ${String(o.bytes).padStart(7)} B  ${String(o.gzip).padStart(6)} B gzip`);
  if (outputs.length > 0) console.log(`budget ${pkg.config.budgetKb} KB gzip; engine code bundled in: ${engineBytes} B`);
  for (const problem of problems) console.log(`  FAIL ${problem}`);
  console.log(`build ${pkg.id}: ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(`build: ${error?.stack ?? error}`); process.exitCode = 4; });
}
