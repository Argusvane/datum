// Copies what the binding pages load live into public/demo/bindings/ (gitignored), beside the demo
// bundles copy-demo-assets.mjs puts in public/demo/ (that script leaves this folder alone):
//
//   <id>/<id>.iife.js         the binding's bundle from bindings/<id>/dist (npm run build there), global from its
//                             package.json "datumBinding"
//   <id>/files/…              the design system's own files, as the pinned release ships them, only those
//                             scripts/binding-assets-spec.mjs lists, with its redactions applied and a NOTICE.txt
//                             beside each package. GDS Transport and the crest are never copied
//   manifest.json             per binding: its script, global, stylesheets, scripts and body class, with
//                             addresses relative to the manifest, so the folder works under any SITE_BASE
//
//   node scripts/copy-binding-assets.mjs               fail when a binding or its files are missing
//   node scripts/copy-binding-assets.mjs --if-present  say so and keep what is there (npm run build)
//
// The page builds each binding with datum-form.js's own `bindings.fromFactory`, so no second lit comes in.
// Run it after copy-demo-assets.mjs: it ends with the scan (scripts/published-scan.mjs) over the whole of
// public/demo/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BINDING_ASSETS, REFERENCE_BINDINGS } from "./binding-assets-spec.mjs";
import { copyBindingFiles, missingVendor, placeCheckFiles, published } from "./binding-files.mjs";
import { scanPublished } from "./published-scan.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(site, "..");
const target = join(site, "public", "demo", "bindings");
const ifPresent = process.argv.includes("--if-present");

const stop = (message) => {
  if (ifPresent) {
    const kept = existsSync(join(target, "manifest.json")) ? "keeping the copy already in public/demo/bindings/" : "the binding pages will show their fallback";
    console.log(`copy-binding-assets: ${message}; ${kept}.`);
    process.exit(0);
  }
  console.error(`copy-binding-assets: ${message}.`);
  process.exit(1);
};

const bindingDir = (id) => join(root, "bindings", id);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const fix = (id) => `run \`npm install\` and \`npm run build\` in bindings/${id}`;

// 1. Check everything is there before touching the target.
const plans = [];
for (const id of REFERENCE_BINDINGS) {
  const dir = bindingDir(id);
  const spec = BINDING_ASSETS[id];
  if (spec === undefined) stop(`binding-assets-spec.mjs has no entry for ${id}`);
  const meta = existsSync(join(dir, "package.json")) ? readJson(join(dir, "package.json")).datumBinding : undefined;
  if (meta === undefined) stop(`bindings/${id} has no datumBinding block`);
  const iife = join(dir, "dist", `${meta.bundle.replace(/^.*\//, "").replace(/\.js$/, "")}.iife.js`);
  if (!existsSync(iife)) stop(`bindings/${id} has no ${relative(dir, iife)}; ${fix(id)}`);
  const missing = missingVendor(dir, spec);
  if (missing.length > 0) stop(`bindings/${id} is missing ${missing.join(", ")}; ${fix(id)}`);
  plans.push({ id, dir, spec, meta, iife, check: readJson(join(dir, "binding-check.json")) });
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// 2. Each binding.
const manifest = {};
for (const { id, dir, spec, meta, iife, check } of plans) {
  const out = join(target, id);
  mkdirSync(join(out, "files"), { recursive: true });
  copyFileSync(iife, join(out, `${id}.iife.js`));
  let count = 0;

  // The copy, the redactions and the notices, then the manifest: the binding-check.json's files, at their
  // published addresses relative to the manifest.
  try {
    const copied = copyBindingFiles({ id, dir, spec, filesDir: join(out, "files") });
    const files = new Set(copied);
    manifest[id] = {
      global: meta.global,
      script: `./${id}/${id}.iife.js`,
      ...placeCheckFiles({ id, check, at: (path) => `./${id}/files/${published(path)}`, has: (path) => files.has(path) })
    };
    count = copied.length;
  } catch (error) {
    console.error(`copy-binding-assets: ${error.message}`);
    process.exit(1);
  }
  console.log(`copy-binding-assets: public/demo/bindings/${id}/  (${count} files)`);
}

writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log("copy-binding-assets: public/demo/bindings/manifest.json");

// GDS Transport and the marks: nothing in public/demo/ (these files) may be GDS Transport or a mark the copies leave out.
const problems = scanPublished(join(site, "public", "demo"));
if (problems.length > 0) {
  console.error(`copy-binding-assets: public/demo/ holds what is never published:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
