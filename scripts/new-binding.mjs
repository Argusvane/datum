#!/usr/bin/env node
// Scaffolds a design-system binding package: bindings/<id>/ with the package block the binding kit
// reads, a binding that draws nothing itself yet (Datum's adapters stand behind every binding),
// the folders the kit's checks use, and the side-effects page every binding keeps.
//
//   node scripts/new-binding.mjs <id> --design-system "Name" --release 1.2.3 [options]
//
//   --design-system   the design system's name (required)
//   --release         the one release the binding pins (required; informational: the pinned devDependency)
//   --package         the npm package that ships the design system's files (adds the pinned alias,
//                     "<package>-<release>": "npm:<package>@<release>", the way every binding pins one)
//   --global          the IIFE global name (default DatumBinding<Id>)
//   --budget-kb       the gzip budget of the ES bundle in KB (default 12)
//   --dir             where to write it (default bindings/<id> in this repository)
//   --dry-run         print the files, write nothing
//
// Then: npm install in the package, add the design system's files to binding-check.json, write the
// first adapter and its reference case, and run `npm run kit:check`.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..");
const ID = /^[a-z][a-z0-9-]*$/;

const pascal = (id) => id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
const unscoped = (name) => name.replace(/^@/, "").replace(/\//g, "-");
const posix = (path) => path.split("\\").join("/");

/** The files of a new package: `{ path: text }`, relative to the package folder. */
export function scaffold({ id, designSystem, release, packageName, global: globalName, budgetKb = 12, dir }) {
  const root = dir ?? join(REPO, "bindings", id);
  const toEngine = posix(relative(join(root, "src"), join(REPO, "engine", "form-engine")));
  const toKit = posix(relative(root, join(REPO, "packages", "datum", "binding-kit")));
  const toEngineRoot = posix(relative(root, join(REPO, "engine")));
  const alias = packageName ? `${unscoped(packageName)}-${release}` : undefined;
  // A package in this repository's bindings/ folder is named to the kit by its id; one written
  // elsewhere (--dir) by its folder: the kit's scripts run in the package, so "." is that folder.
  const target = resolve(root) === join(REPO, "bindings", id) ? id : ".";
  const kit = (script, extra = "") => `node ${toKit}/${script}.mjs --binding ${target}${extra}`;
  const manifest = {
    name: `@argusvane/datum-binding-${id}`,
    version: "0.1.0",
    private: true,
    license: "MIT",
    description: `${designSystem} binding for the Datum form renderer: Datum's components drawn in the design system's own markup.`,
    type: "module",
    datumBinding: { id, designSystem, release, bundle: `dist/${id}.js`, global: globalName ?? `DatumBinding${pascal(id)}`, budgetKb },
    scripts: {
      build: kit("build"),
      typecheck: "tsc --noEmit",
      "kit:check": kit("check"),
      "kit:build": kit("build"),
      "kit:equality": kit("equality"),
      "kit:behaviour": kit("behaviour"),
      "kit:conformance": `node ${toKit}/conformance.ts --binding ${target}`,
      "kit:serve": kit("serve")
    },
    devDependencies: Object.fromEntries(
      Object.entries({
        "@argusvane/datum-engine": `file:${toEngineRoot}`,
        esbuild: "^0.28.2",
        ...(alias ? { [alias]: `npm:${packageName}@${release}` } : {}),
        typescript: "^7.0.2"
      }).sort(([a], [b]) => a.localeCompare(b))
    )
  };
  const files = {};
  files["package.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  files["README.md"] = `# @argusvane/datum-binding-${id}

The ${designSystem} binding for Datum: it draws Datum's components in ${designSystem}'s own markup, pinned to release ${release}${alias ? ` (the \`${alias}\` devDependency alias; updating it is a manual refresh)` : ""}.

\`\`\`
npm install
npm run kit:check        # package, build, tokens, binding, equality, behaviour, datum-binding-check
npm run kit:serve        # the reference and the binding side by side (ports 5200-5219)
\`\`\`

Write it from docs/binding-authoring.md. What this binding does outside its own form is in docs/side-effects.md.
`;
  files["tsconfig.json"] = `${JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM", "DOM.Iterable"], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, isolatedModules: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ["src/**/*.ts"]
  }, null, 2)}\n`;
  files["binding-check.json"] = `${JSON.stringify({
    designSystem,
    binding: "src/index.ts",
    stylesheets: [],
    scripts: [],
    fonts: []
  }, null, 2)}\n`;
  files["src/index.ts"] = `/**
 * The ${designSystem} binding on the engine contract: \`createBinding(lit, datum)\`.
 *
 * It draws nothing itself yet: a component type with no adapter here is drawn by Datum's adapter
 * (the lookup is binding[type] -> binding[base] -> datum[type] -> datum[base]), tinted with
 * \`fallbackTokens\` (names with the two leading dashes: "--color-text"; the list is FORM_TOKENS in
 * render/live/datum/tokens.ts). Add adapters under \`components\`, one per Datum component type, and
 * wrap Datum's where the design system differs only a little (\`datum.components.text\`).
 * docs/binding-authoring.md section 3 ("A first adapter") is a complete text field to start from.
 *
 * Host files (never the binding's): the design system's stylesheet, fonts and scripts, listed in
 * binding-check.json for the kit and passed as \`assets\` by a host.
 */
import type { BindingFactory, LiveBinding } from "${toEngine}/render/live/contract.js";

export const createBinding: BindingFactory = (_lit, _datum): LiveBinding => ({
  id: "${id}",
  label: ${JSON.stringify(designSystem)},
  designSystem: { name: ${JSON.stringify(designSystem)} },
  components: {},
  // Rules for what the binding draws itself, adopted after the design system's stylesheet.
  css: "",
  // Datum's tokens in the design system's values, for what Datum draws inside this binding.
  fallbackTokens: {},
  errorFocus: "summary"
});
`;
  files["reference/text-field.html"] = `<!-- datum-reference
{
  "source": "REPLACE: the design system's template or documentation page this markup comes from",
  "skip": "replace this placeholder with the design system's own markup for a required text field, then delete this key",
  "components": [ { "id": "name", "type": "text", "configuration": { "label": "Full name", "required": true } } ],
  "root": "form",
  "width": 560
}
-->
<form novalidate>
  <!-- the design system's markup for a labelled text field goes here -->
</form>
`;
  files["tests/tier2/.gitkeep"] = "";
  files["docs/side-effects.md"] = `# ${designSystem} binding: side effects outside the form

A binding draws inside the form's shadow root. Anything it, or the design system's own script, does
beyond that is listed here, with how it is undone. State "none" explicitly where it is none; a blank
line is a question not yet asked.

## Document-level styles and fonts

<!-- @font-face rules go to document.adoptedStyleSheets (the renderer does this for the host's fonts assets, one sheet per binding, released on the last unmount). Does the design system add other sheets to the document or the shadow root (a Stencil library's shared sheet)? -->

## Listeners, timers and observers on window, document or body

<!-- The design system's scripts: what each adds, and what the binding's connect() removes on unmount. -->

## Markers on <body> or <html>

<!-- A class the design system's script reads or writes (GOV.UK: govuk-frontend-supported). -->

## Nodes added outside the form's root

<!-- Overlays, tooltips, live regions the design system's script appends to document.body. selfCheck reports them. -->

## Globals

<!-- What the design system's classic script defines on window. -->

## What the host must provide

<!-- The files (stylesheet, scripts, fonts), the page language, the body class, the page font and its licence. -->
`;
  return { root, files };
}

export function write({ root, files }, { dryRun = false } = {}) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    if (dryRun) { console.log(`  ${file}`); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

export function main(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === "--design-system") args.designSystem = next();
    else if (arg === "--release") args.release = next();
    else if (arg === "--package") args.packageName = next();
    else if (arg === "--global") args.global = next();
    else if (arg === "--budget-kb") args.budgetKb = Number(next());
    else if (arg === "--dir") args.dir = resolve(next());
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else args._.push(arg);
  }
  if (args.help) {
    console.log("usage: node scripts/new-binding.mjs <id> --design-system \"Name\" --release 1.2.3 [--package npm-name] [--global Name] [--budget-kb 12] [--dir path] [--dry-run]");
    return 0;
  }
  const id = args._[0];
  if (!id || !ID.test(id)) throw new Error('give the binding an id: lower case letters, digits and hyphens, starting with a letter (for example "govuk")');
  if (!args.designSystem) throw new Error("--design-system is required");
  if (!args.release) throw new Error("--release is required (the one release the binding pins)");
  if (args.budgetKb !== undefined && !(args.budgetKb > 0)) throw new Error("--budget-kb must be a positive number");
  const made = scaffold({ id, designSystem: args.designSystem, release: args.release, packageName: args.packageName, global: args.global, budgetKb: args.budgetKb, dir: args.dir });
  if (existsSync(join(made.root, "package.json"))) throw new Error(`${made.root} already holds a package: nothing was written`);
  console.log(args.dryRun ? `would write ${made.root}:` : `writing ${made.root}:`);
  write(made, { dryRun: args.dryRun });
  if (!args.dryRun) {
    console.log(`\nNext, in ${made.root}:\n  npm install\n  fill binding-check.json with the design system's files (paths under /node_modules/, served from the package), write src/index.ts and reference/*.html\n  npm run kit:check   (exits 2, "nothing asserted", until a reference case replaces the skipped placeholder)\nThe guide: docs/binding-authoring.md`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`new-binding: ${error.message}`);
    process.exitCode = 2;
  }
}
