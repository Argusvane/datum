// Builds the GOV.UK binding module on the engine contract with esbuild (this package's
// devDependency). Two outputs in ./dist (gitignored): an ES module
// (`govuk.js`, what `datum-binding-check --binding` and a host's `import()` take) and an IIFE
// (`govuk.iife.js`, `DatumBindingGovuk.createBinding`). The binding imports lit by type only (the
// host hands it lit); the one runtime import from the engine is readTypedNumber, bundled in.
// Run: node bindings/govuk/src/build.mjs
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const esbuild = createRequire(join(here, "..", "package.json"))("esbuild");

const common = { entryPoints: [join(here, "index.ts")], bundle: true, target: "es2022", minify: true, logLevel: "warning" };
await esbuild.build({ ...common, format: "esm", outfile: join(here, "..", "dist", "govuk.js") });
await esbuild.build({ ...common, format: "iife", globalName: "DatumBindingGovuk", outfile: join(here, "..", "dist", "govuk.iife.js") });
for (const file of ["govuk.js", "govuk.iife.js"]) {
  const bytes = readFileSync(join(here, "..", "dist", file));
  console.log(`${file}: ${(bytes.length / 1024).toFixed(1)} KB, ${(gzipSync(bytes).length / 1024).toFixed(1)} KB gzip`);
}
