// Builds the GC Design System binding with esbuild (this package's devDependency).
//   node src/build.mjs          -> dist/gcds.js (ES module, exports createBinding + gcdsKinds)
//                                  dist/gcds.iife.js (global DatumBindingGcds.createBinding)
// The build always fails when the bundle imports anything (a binding bundles no lit and no engine code).
// The binding takes lit as the argument of createBinding(lit), so no lit-html is in the output.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const esbuild = createRequire(join(here, "..", "package.json"))("esbuild");
const out = join(here, "..", "dist");
mkdirSync(out, { recursive: true });

const common = { entryPoints: [join(here, "binding.ts")], bundle: true, target: "es2022", minify: true, logLevel: "warning", metafile: true };
const sizes = [];
for (const [format, file, extra] of [
  ["esm", "gcds.js", {}],
  ["iife", "gcds.iife.js", { globalName: "DatumBindingGcds" }]
]) {
  const result = await esbuild.build({ ...common, format, outfile: join(out, file), ...extra });
  const bytes = readFileSync(join(out, file));
  sizes.push({ file, bytes: bytes.length, gzip: gzipSync(bytes).length });
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.filter((entry) => !entry.external || true).map((entry) => entry.path));
  if (imports.length > 0) throw new Error(`${file} imports ${imports.join(", ")}: a binding bundles no engine or lit code`);
  const text = bytes.toString("utf8");
  if (/litHtmlVersions|lit-html/.test(text)) throw new Error(`${file} carries lit-html: lit arrives through createBinding(lit)`);
}
writeFileSync(join(out, "sizes.json"), JSON.stringify(sizes, null, 2));
for (const size of sizes) console.log(`${size.file.padEnd(14)} ${String(size.bytes).padStart(7)} B  ${String(size.gzip).padStart(6)} B gzip`);
