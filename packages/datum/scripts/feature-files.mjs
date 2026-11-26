// The feature -> files manifest: which files of dist/ belong to which
// optional feature, so a host that leaves a feature out can delete exactly those files and a
// browser check can prove the page still works without them. Run after the build; writes
// dist/feature-files.json:
//
//   { generatedAt,
//     features: { <token>: { bundle: "form" | "builder" | "both", files: [dist-relative], bytes, gzipBytes } },
//     aliases: { <token>: <token whose files it names> },
//     core: [{ file, note }],     // lazy files that are NOT removable, and why
//     unattributed: [] }          // lazy files no rule and no importer explained: a build defect
//
// Tokens are the renderer's FORM_FEATURES (engine/form-engine/render/web-component/form-features.ts) and the builder's
// BUILDER_FEATURES (builder-features.ts), read from those files, plus the names of the files'
// own feature: pdf, pdf-pages, wasm, webauthn, validate-url. The renderer's `signing` and
// `server-validation` are the same files as `webauthn` and `validate-url` (aliases); a token that
// is only a behaviour gate (print, drafts, binding-picker, ...) lists no files.
//
// Attribution, per lazy chunk (`datum-<form|builder|pdf>-<name>-<hash>.js`):
//   1. a chunk is claimed by a feature when its <name> is one the feature lists, or it carries a
//      sentinel string the bundle guards use (scripts/guards/04..06): two claimants make it core;
//   2. a chunk nobody claims follows its importers: only one feature's files import it -> that
//      feature; the bundle's entry or core code imports it, or two features share it -> core;
//   3. a claimed chunk that core code imports statically, or that another feature's file imports
//      (by either kind of import), is demoted to core: deleting it would break that other file.
// A file shared by two features is therefore core and never removable. Entry bundles
// (datum-form.js, datum-builder.js and their classic-script twins) are never listed. The import
// graph is read from the built text (`from"./x.js"`, `import"./x.js"`, `("./x.js")`), so the file
// names are the build's own: read the manifest of the SAME build before deleting anything.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

// dirname(), not new URL("."): the unit test imports this under jsdom, whose URL is not Node's.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tokens the manifest names beyond the two models' lists. */
const EXTRA_TOKENS = ["pdf", "pdf-pages", "wasm", "webauthn", "validate-url", "journeys", "signing", "try-it"];

/** Tokens whose files are another token's. */
const ALIASES = { signing: "webauthn", "server-validation": "validate-url" };

// Strings only one feature's code spells (the same ones scripts/guards/04..06 use). `bundles`
// limits a sentinel to chunks of those bundles: "theme.notFound" is the form's PDF theme logic,
// but the builder's entry chunk may carry it legitimately.
const SENTINELS = {
  webauthn: [{ text: "No passkey or security key is registered to sign with." }],
  "validate-url": [{ text: "without an errors array" }],
  pdf: [{ text: "pdf-empty-add", bundles: ["builder"] }, { text: "mapping.unresolved", bundles: ["form"] }, { text: "theme.notFound", bundles: ["form"] }],
  journeys: [{ text: "journey-load-note", bundles: ["builder"] }],
  "header-footer": [{ text: "data-chrome-more", bundles: ["builder"] }],
  variables: [{ text: "data-variables-syntax", bundles: ["builder"] }],
  // The Tests panel's Run all button (guard 14): markup only builder-tests-panel.ts writes.
  tests: [{ text: "data-tests-run-all", bundles: ["builder"] }],
  // The agent tools (guard 15): each bundle's chunk is told by its catalogue's first tool
  // name, describe_form in the form bundle and describe_builder in the builder bundle. The
  // registrar's handle hints spell both, so each sentinel counts only among its own bundle's files.
  agent: [{ text: "describe_form", bundles: ["form"] }, { text: "describe_builder", bundles: ["builder"] }]
};

// The chunk names (the <name> of `datum-<bundle>-<name>-<hash>.js`, vite.config.ts) each feature owns.
const CHUNK_NAMES = {
  webauthn: ["webauthn"],
  "validate-url": ["server-validator"],
  pdf: ["pdf-service", "pdf", "pdf-builder-mode", "pdf-designer-chunk"],
  "pdf-pages": ["pdf-pages"],
  // journey-engine-chunk is the renderer's lazy journeys runtime (src/journey-engine-chunk.ts);
  // a path-engine chunk it shares with journey-diagnostics follows its importers (both are `journeys`).
  // journey-review-chunk is a journey's Check answers page (src/journey-review-chunk.ts), loaded beside it for a journey with one.
  journeys: ["journey-diagnostics", "journey-builder-mode", "journey-designer", "journey-authoring", "journey-map", "journey-preview", "journey-engine-chunk", "journey-review-chunk"],
  logic: ["logic-surface", "logic-model"],
  data: ["data-surface"],
  "data-model": ["generate"],
  languages: ["languages-surface"],
  // The Print workspace (guard 18): its surface, model, sheet and words in one chunk.
  print: ["print-surface"],
  variables: ["builder-variables-panel"],
  "header-footer": ["builder-chrome-panel"],
  // The Tests panel and its CodeMirror editor, a second chunk behind the panel's.
  tests: ["builder-tests-panel", "tests-editor"],
  palette: ["command-palette"],
  json: ["json-viewer"],
  "try-it": ["try-it"],
  // One chunk per bundle (src/agent.ts, src/builder/agent.ts), and the builder's three body chunks
  // (agent/builder/agentpart-<area>.ts). Vite names a lazy chunk after its entry module's
  // basename, so the bodies are agentpart-*, never try-it-*, which would collide with the Try it chunk's name. The bodies
  // carry no catalogue sentinel (describe_builder is the main chunk's), so they are claimed by name.
  agent: ["agent", "agentpart-try", "agentpart-languages", "agentpart-documents"]
};

/** Whole files that are no chunk of the bundles but load on demand from beside them (the `pdf`, `pdf-pages` and `wasm` attributes). */
const STANDALONE = {
  pdf: ["datum-pdf.js"],
  "pdf-pages": ["datum-pdf-pages.js"],
  wasm: ["datum-wasm.js"]
};

/** Directories of assets only a feature's module fetches (the PDF fonts, pdf.js's data), listed file by file. */
const ASSET_DIRS = {
  pdf: ["fonts"],
  "pdf-pages": ["pdfjs"]
};

const ENTRIES = new Set(["datum-form.js", "datum-builder.js", "datum-form.iife.js", "datum-builder.iife.js"]);
const CHUNK = /^datum-(form|builder|pdf)-(.+)-([A-Za-z0-9_-]{8})\.js$/;

// Chunks the build itself adds beside the entries (Vite 8 / Rolldown), core by rule, whatever imports them:
// the shared-module chunk of an entry's own load set, which the entry imports statically on load, and the
// bundler's runtime helpers chunk. Both are read as importers like an entry: a lazy chunk only a core file
// imports follows rule 2 below, from that core file. The core chunk is also what a rule 3 demotion tests
// against: a feature's chunk the core chunk imports statically is core.
const BUILD_CORE = [
  { pattern: /^datum-(form|builder)-core-[A-Za-z0-9_-]{8}\.js$/, note: "the entry imports it statically on load: Rolldown's shared-module chunk for the entry's own load set (vite.config.ts, scripts/build-bundles.mjs)" },
  { pattern: /^datum-(form|builder|pdf)-rolldown-runtime-[A-Za-z0-9_-]{8}\.js$/, note: "the bundler's runtime helpers, imported by chunks of the bundle" }
];

function readTokens(file, name) {
  const match = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(readFileSync(file, "utf8"));
  if (!match) {
    throw new Error(`feature-files: ${name} not found in ${file}`);
  }
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((token) => token[1]);
}

/** The renderer's and the builder's feature tokens, read from the files that define them. */
export function readFeatureTokens() {
  return {
    form: readTokens(join(packageRoot, "..", "..", "engine", "form-engine", "render", "web-component", "form-features.ts"), "FORM_FEATURES"),
    builder: readTokens(join(packageRoot, "..", "..", "engine", "form-engine", "builder", "web-component", "builder-features.ts"), "BUILDER_FEATURES")
  };
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path, base));
    } else {
      out.push(relative(base, path).split("\\").join("/"));
    }
  }
  return out;
}

/** Every `"./datum-*.js"` string in a built file, with whether it is an import statement (static) rather than a call or a URL (lazy). */
function references(text) {
  const statics = new Set([...text.matchAll(/\b(?:from|import)\s*["']\.\/(datum-[A-Za-z0-9_.-]+?\.js)["']/g)].map((match) => match[1]));
  return [...new Set([...text.matchAll(/["']\.\/(datum-[A-Za-z0-9_.-]+?\.js)["']/g)].map((match) => match[1]))].map((target) => ({ target, static: statics.has(target) }));
}

/**
 * Reads the build in `dist` and attributes its lazy files to features. Pure of side effects
 * (the script below writes the result; the guard in scripts/guards/11-feature-files.mjs calls it
 * from inside check-bundles, before the script has run). `options.tokens` replaces the token
 * lists read from the sources (tests); `options.now` the timestamp.
 */
export function computeFeatureFiles(dist, options = {}) {
  const tokens = options.tokens ?? readFeatureTokens();
  const all = [...new Set([...tokens.form, ...tokens.builder, ...EXTRA_TOKENS])];
  const jsFiles = readdirSync(dist).filter((name) => name.endsWith(".js") && !name.endsWith(".iife.js"));
  const texts = new Map();
  const text = (name) => {
    if (!texts.has(name)) {
      texts.set(name, readFileSync(join(dist, name), "utf8"));
    }
    return texts.get(name);
  };

  const chunks = jsFiles.filter((name) => CHUNK.test(name));
  const chunkInfo = (name) => {
    const [, bundle, base] = CHUNK.exec(name);
    return { bundle, base };
  };

  // Who imports whom: only the files that can import a chunk (the bundles and their chunks).
  const importers = new Map();
  for (const name of jsFiles.filter((file) => /^datum-(form|builder|pdf)(-|\.js)/.test(file))) {
    for (const ref of references(text(name))) {
      if (ref.target === name || !jsFiles.includes(ref.target)) {
        continue;
      }
      const list = importers.get(ref.target) ?? [];
      list.push({ file: name, static: ref.static });
      importers.set(ref.target, list);
    }
  }

  const owner = new Map(); // file -> feature token | "core"
  const notes = new Map(); // core file -> why
  const setCore = (file, note) => {
    owner.set(file, "core");
    notes.set(file, note);
  };
  for (const entry of ENTRIES) {
    owner.set(entry, "core");
  }
  for (const [feature, list] of Object.entries(STANDALONE)) {
    for (const file of list) {
      if (jsFiles.includes(file)) {
        owner.set(file, feature);
      }
    }
  }

  // The build's own core chunks: core before any claim, so a sentinel a core chunk happens to spell never makes it a feature's.
  for (const file of chunks) {
    const rule = BUILD_CORE.find(({ pattern }) => pattern.test(file));
    if (rule) {
      setCore(file, rule.note);
    }
  }

  // 1. Claims by name and sentinel.
  for (const file of chunks.filter((name) => !owner.has(name))) {
    const { bundle, base } = chunkInfo(file);
    const claims = new Set();
    for (const [feature, list] of Object.entries(CHUNK_NAMES)) {
      if (list.includes(base)) {
        claims.add(feature);
      }
    }
    for (const [feature, list] of Object.entries(SENTINELS)) {
      if (list.some((sentinel) => (!sentinel.bundles || sentinel.bundles.includes(bundle)) && text(file).includes(sentinel.text))) {
        claims.add(feature);
      }
    }
    if (claims.size === 1) {
      owner.set(file, [...claims][0]);
    } else if (claims.size > 1) {
      setCore(file, `claimed by ${[...claims].sort().join(" and ")}: shared, so never removable`);
    }
  }

  // 2. The rest follow their importers until nothing changes.
  const describe = (importer) => (owner.get(importer.file) === "core" ? importer.file : `${importer.file} (${owner.get(importer.file)})`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of chunks.filter((name) => !owner.has(name))) {
      const list = importers.get(file) ?? [];
      if (list.length === 0) {
        continue;
      }
      const owners = list.map((importer) => owner.get(importer.file));
      if (owners.some((value) => value === undefined)) {
        continue;
      }
      const set = new Set(owners);
      if (set.size === 1 && !set.has("core")) {
        owner.set(file, owners[0]);
      } else if (set.has("core") && set.size === 1) {
        setCore(file, `imported by core code (${list.map((importer) => importer.file).join(", ")}), no feature owns it`);
      } else {
        setCore(file, `shared by ${[...set].sort().join(" and ")} (${list.map(describe).join(", ")})`);
      }
      changed = true;
    }
  }

  // 3. A claimed chunk another file depends on is core.
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of chunks.filter((name) => owner.get(name) !== undefined && owner.get(name) !== "core")) {
      const mine = owner.get(file);
      for (const importer of importers.get(file) ?? []) {
        const theirs = owner.get(importer.file);
        if (theirs === mine || theirs === undefined) {
          continue;
        }
        if (theirs === "core" && !importer.static) {
          continue; // the lazy loader in core code: the point of the chunk
        }
        setCore(file, `${importer.static ? "statically " : ""}imported by ${importer.file} (${theirs}): shared, so never removable`);
        changed = true;
        break;
      }
    }
  }

  const unattributed = chunks.filter((name) => !owner.has(name)).sort();

  const features = {};
  for (const token of all) {
    const files = [];
    for (const [file, value] of owner) {
      if (value === token) {
        files.push(file);
      }
    }
    for (const directory of ASSET_DIRS[token] ?? []) {
      if (existsSync(join(dist, directory))) {
        files.push(...walk(join(dist, directory), dist));
      }
    }
    files.sort();
    const kinds = new Set(files.map((file) => (CHUNK.test(file) && chunkInfo(file).bundle !== "pdf" ? chunkInfo(file).bundle : "both")));
    const declared = tokens.form.includes(token) && !tokens.builder.includes(token) ? "form" : tokens.builder.includes(token) && !tokens.form.includes(token) ? "builder" : "both";
    const contents = files.map((file) => readFileSync(join(dist, file)));
    features[token] = {
      bundle: kinds.size === 1 ? [...kinds][0] : declared,
      files,
      bytes: contents.reduce((sum, bytes) => sum + bytes.length, 0),
      gzipBytes: contents.reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0)
    };
    if (ALIASES[token]) {
      features[token] = { ...features[token], aliasOf: ALIASES[token] };
    }
  }

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    features,
    aliases: ALIASES,
    core: [...notes].map(([file, note]) => ({ file, note })).sort((a, b) => a.file.localeCompare(b.file)),
    unattributed
  };
}

/** The files a token means to delete, following an alias. */
export function filesOf(manifest, token) {
  const feature = manifest.features[manifest.aliases?.[token] ?? token];
  return feature ? feature.files : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = join(packageRoot, "dist");
  if (!existsSync(dist)) {
    console.error("feature-files: dist/ is missing, run `npm run build` first");
    process.exit(2);
  }
  const manifest = computeFeatureFiles(dist);
  writeFileSync(join(dist, "feature-files.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [token, feature] of Object.entries(manifest.features)) {
    const note = feature.aliasOf ? ` (same files as ${feature.aliasOf})` : feature.files.length === 0 ? " (a behaviour gate; no files)" : "";
    console.log(`feature-files: ${token.padEnd(16)} ${String(feature.files.length).padStart(3)} files ${String(feature.bytes).padStart(9)} B ${String(feature.gzipBytes).padStart(8)} B gz${note}`);
  }
  console.log(`feature-files: ${manifest.core.length} lazy files are core, ${manifest.unattributed.length} unattributed -> dist/feature-files.json`);
  if (manifest.unattributed.length > 0) {
    console.error(`feature-files: unattributed: ${manifest.unattributed.join(", ")}`);
    process.exit(1);
  }
}
