// The host-neutral half of a host's asset build (every host's build script reuses
// it): reading the catalog, refusing a stale dist/, --omit-features, staging and swapping an
// assets/ directory, the skip rules for what a host ships, the programs' ABIs, the build id and
// the manifest. What stays with each host: which modules or artifacts exist, how the files are
// laid out and the descriptor files that declare them. Plain ESM over node builtins only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

/** The repository root (this file lives in integrations/shared/). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** packages/datum/dist, where every bundle is built. */
export const distDir = join(repoRoot, "packages", "datum", "dist");
/** The catalog script, run by readCatalog unless a host names its own. */
export const catalogScript = join(dirname(fileURLToPath(import.meta.url)), "catalog.ts");

/** Prints the message and exits 1: a build refusal. */
export const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// Server-only programs and the classic-script builds stay out of the browser files: a loader
// imports ES modules, and the two programs go where only the server reads them.
export const SKIP_FILES = new Set(["datum-sandbox-program.js", "datum-pdf-program.js"]);
export const SKIP_DIRS = new Set(["types"]);
/** True for a dist/ file name no host ships as a browser file (classic-script builds, maps, typings, the server programs). */
export const isSkippedFileName = (name) => SKIP_FILES.has(name) || name.endsWith(".iife.js") || name.endsWith(".map") || name.endsWith(".d.ts");

/**
 * The cpSync filter over dist/ for a host's browser files. `splitDirs` and `splitFiles` are the
 * directories and files other modules ship (kept out of this one); `omittedFiles` is what
 * parseOmitFeatures left out.
 */
export const createKeep = ({ dist = distDir, splitDirs = new Set(), splitFiles = new Set(), omittedFiles = new Set() } = {}) => (source) => {
  const name = relative(dist, source);
  if (name === "") {
    return true;
  }
  const top = name.split(/[\\/]/)[0];
  if (SKIP_DIRS.has(top) || splitDirs.has(top) || splitFiles.has(name)) {
    return false;
  }
  // A file of a feature the site leaves out (--omit-features). A directory such as
  // fonts/ stays and is filtered file by file; an emptied one is copied empty, which is harmless.
  if (omittedFiles.has(name.split("\\").join("/"))) {
    return false;
  }
  if (statSync(source).isDirectory()) {
    return true;
  }
  return !isSkippedFileName(name);
};

// --omit-features=pdf,journeys (or "pdf journeys"): the feature tokens whose files stay out of
// the browser files. dist/feature-files.json (scripts/feature-files.mjs, written by the same
// build) lists the removable files of each token; files it does not list (the entries, the core
// chunks) are never skipped. A token that is only a behaviour gate (print, drafts, ...) lists no
// files.
export const FEATURE_FILE_ALIASES = { webauthn: "signing", "validate-url": "server-validation" };

/**
 * Reads --omit-features=<tokens> from `argv` and returns { omittedFeatures, omittedFiles,
 * omittedBytes }; exits 1 on an unknown token or a feature-files.json from another build.
 */
export const parseOmitFeatures = (argv = process.argv, dist = distDir, { label = "build-assets", settingsHint = "Datum settings » Features" } = {}) => {
  const omitArg = argv.find((arg) => arg.startsWith("--omit-features="));
  const omittedFeatures = [];
  const omittedFiles = new Set();
  let omittedBytes = 0;
  if (omitArg !== undefined) {
    const requested = [...new Set(omitArg.slice("--omit-features=".length).split(/[\s,]+/).filter(Boolean))];
    const featureFilesPath = join(dist, "feature-files.json");
    if (requested.length > 0 && !existsSync(featureFilesPath)) {
      console.error(`${label}: --omit-features needs packages/datum/dist/feature-files.json — run \`npm run datum:build\` first.`);
      process.exit(1);
    }
    const featureFiles = requested.length > 0 ? JSON.parse(readFileSync(featureFilesPath, "utf8")) : { features: {} };
    const known = Object.keys(featureFiles.features ?? {});
    const unknown = requested.filter((token) => !known.includes(token));
    if (unknown.length > 0) {
      console.error(`${label}: --omit-features names ${unknown.join(", ")}, which dist/feature-files.json does not have. Known: ${known.join(", ")}.`);
      process.exit(1);
    }
    for (const token of requested) {
      const entry = featureFiles.features[token];
      // The aliases list no files of their own; their target's are the ones to skip.
      const target = featureFiles.aliases?.[token] ?? token;
      const files = featureFiles.features[target]?.files ?? entry.files;
      const absent = files.filter((file) => !existsSync(join(dist, file)));
      if (absent.length > 0) {
        console.error(`${label}: dist/feature-files.json lists ${absent.slice(0, 3).join(", ")}${absent.length > 3 ? ` and ${absent.length - 3} more` : ""} for ${token}, which dist/ does not have — the manifest is from another build; run \`npm run datum:build\` again.`);
        process.exit(1);
      }
      if (files.length === 0) {
        console.warn(`${label}: ${token} has no files of its own (a behaviour gate): nothing is left out for it; leave it out in ${settingsHint}.`);
      }
      for (const file of files) {
        // The fonts are the PDF feature's in the browser, but a server's PDF program embeds the
        // same files: they always ship.
        if (!file.startsWith("fonts/") && !omittedFiles.has(file)) {
          omittedFiles.add(file);
          omittedBytes += statSync(join(dist, file)).size;
        }
      }
      // The renderer's word for a shared file set is the one a site's settings use; a base token a
      // site cannot name (webauthn, validate-url) is recorded under that word.
      omittedFeatures.push(FEATURE_FILE_ALIASES[token] ?? token);
    }
    omittedFeatures.sort();
    const recorded = [...new Set(omittedFeatures)];
    omittedFeatures.length = 0;
    omittedFeatures.push(...recorded);
  }
  return { omitArg, omittedFeatures, omittedFiles, omittedBytes };
};

/** The --dry-run line for parseOmitFeatures' result (printed by the host, which then exits). */
export const describeOmission = ({ omitArg, omittedFeatures, omittedFiles, omittedBytes }, label = "build-assets") => omitArg === undefined
  ? `${label} --dry-run: no --omit-features given, so everything would ship.`
  : `${label} --dry-run: would leave out ${omittedFiles.size} file(s), ${(omittedBytes / 1024).toFixed(1)} KiB, for ${omittedFeatures.length > 0 ? omittedFeatures.join(", ") : "no feature"}:\n${[...omittedFiles].sort().map((file) => `  ${file}`).join("\n")}`;

/**
 * Staging: each target's assets are built in <dir>/assets.new and swapped in at the end. Returns
 * { stage(dir) -> path, swap() }; the exit handler is installed here. However the build ends
 * before the swap — fail(), or an uncaught throw (a file that went from a dist/ another session
 * is rebuilding) — the staged directories go with it. Once the swap has begun they are left
 * alone, since a target's assets/ may already be gone and its assets.new/ is then the only copy.
 * Signals keep their default (the build is synchronous, so a handler would only run once it had
 * finished): a killed build leaves its assets.new/ for the next one, whose stage() removes them
 * first.
 */
export const createStaging = () => {
  const STAGE = "assets.new";
  const staged = [];
  let swapping = false;
  // `stageName`/`finalName` default to one layout (<dir>/assets.new swapped in as <dir>/assets); a build
  // whose finished module directories are <out>/<module>, names both (<out>/<module>.new swapped in as <out>/<module>).
  const stage = (dir, { stageName = STAGE, finalName = "assets" } = {}) => {
    const path = join(dir, stageName);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    staged.push({ path, final: join(dir, finalName) });
    return path;
  };
  const discardStaged = () => {
    for (const entry of staged) {
      rmSync(entry.path, { recursive: true, force: true });
    }
  };
  process.on("exit", () => {
    if (!swapping) {
      discardStaged();
    }
  });
  /** Everything built: swap each assets.new in over its assets/. */
  const swap = () => {
    swapping = true;
    for (const entry of staged) {
      rmSync(entry.final, { recursive: true, force: true });
      renameSync(entry.path, entry.final);
    }
  };
  return { stage, swap, discardStaged };
};

/** The catalog, read from the TypeScript sources the bundles are built from (vite-node). */
export const readCatalog = (script = catalogScript, repo = repoRoot, label = "build-assets") => {
  const viteNode = join(repo, "packages", "datum", "node_modules", ".bin", "vite-node");
  const catalogRun = spawnSync(viteNode, ["--root", join(repo, "packages", "datum"), script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (catalogRun.status !== 0) {
    console.error(catalogRun.stderr);
    fail(`${label}: the catalog script failed.`);
  }
  return JSON.parse(catalogRun.stdout);
};

const newestUnder = (dir) => {
  let newest = { time: 0, path: dir };
  if (!existsSync(dir)) {
    return newest;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath ?? entry.path, entry.name);
      const time = statSync(path).mtimeMs;
      if (time > newest.time) {
        newest = { time, path };
      }
    }
  }
  return newest;
};

/**
 * The shared glue and SQL: inputs of every host's assets (copied into them), not sources of
 * packages/datum/dist (nothing compiles them into a bundle). An edit there is a run of the
 * host's own build-assets, never a forgotten `datum:build`, so the staleness comparison
 * leaves them out even when a caller lists them (touching a glue file must not make a clean root build
 * refuse until the dist is rebuilt for nothing).
 */
export const copiedInputDirs = [join(repoRoot, "integrations", "shared", "glue"), join(repoRoot, "integrations", "shared", "db")];

const isCopiedInput = (dir) => copiedInputDirs.some((input) => dir === input || dir.startsWith(`${input}${sep}`));

/**
 * A dist/ older than the sources it is built from is a forgotten rebuild: the oldest bundle a
 * host ships (`shippedBundles`, names under dist/) must be newer than the newest file under
 * `sourceDirs`, less the copied inputs (`copiedInputDirs`: the shared glue and SQL, which are
 * not dist sources). `allowStale` (--allow-stale) downgrades the refusal to a warning (a checkout's
 * mtimes say nothing about age).
 */
export const assertFreshDist = ({ shippedBundles, sourceDirs, allowStale = false, dist = distDir, repo = repoRoot, label = "build-assets" }) => {
  const oldestBundle = shippedBundles.map((name) => ({ time: statSync(join(dist, name)).mtimeMs, path: join(dist, name) })).reduce((oldest, bundle) => (bundle.time < oldest.time ? bundle : oldest), { time: Infinity, path: dist });
  const newestSource = sourceDirs.filter((dir) => !isCopiedInput(dir)).map(newestUnder).reduce((newest, source) => (source.time > newest.time ? source : newest), { time: 0, path: repo });
  if (newestSource.time > oldestBundle.time) {
    const message = `${label}: packages/datum/dist is older than the sources (newest source ${relative(repo, newestSource.path)}, ${new Date(newestSource.time).toISOString()}; oldest bundle ${relative(repo, oldestBundle.path)}, ${new Date(oldestBundle.time).toISOString()}): run \`npm run datum:build\`.`;
    if (allowStale) {
      console.warn(`${message} Continuing (--allow-stale).`);
    } else {
      fail(`${message} Or pass --allow-stale.`);
    }
  }
};

/**
 * The two programs' ABI versions, from their text: the sandbox program's banner names its ABI;
 * the PDF program's names none, since it installs a global when evaluated (`__datum_pdf_abi`), so
 * it is evaluated once in a bare context, as its own build does, and asked.
 */
export const programAbis = (sandboxProgramText, pdfProgramText, label = "build-assets") => {
  const sandboxAbi = /ABI (\d+\.\d+\.\d+)/.exec(sandboxProgramText)?.[1];
  if (!sandboxAbi) {
    fail(`${label}: the sandbox program's banner names no ABI version.`);
  }
  let pdfAbi;
  try {
    const context = createContext({});
    runInContext(pdfProgramText, context, { filename: "datum-pdf-program.js" });
    pdfAbi = runInContext("globalThis.__datum_pdf_abi", context);
  } catch (error) {
    fail(`${label}: the PDF program throws when evaluated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof pdfAbi !== "string" || !/^\d+\.\d+\.\d+$/.test(pdfAbi)) {
    fail(`${label}: the PDF program installs no ABI version (__datum_pdf_abi is ${String(pdfAbi)}).`);
  }
  return { sandboxAbi, pdfAbi };
};

/** One build id over every file under `assets`: the loader's cache-busting query. */
export const buildIdOf = (assets) => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        hash.update(relative(assets, path));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(assets);
  return hash.digest("hex").slice(0, 12);
};

/** The semver range extensions declare against the engine this build ships. */
export const engineRangeOf = (catalog) => `^${catalog.engineVersion}`;

/** The git commit of the checkout, or null outside one. */
export const gitSource = (repo = repoRoot) => {
  const gitSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  return gitSha.status === 0 ? gitSha.stdout.trim() : null;
};

/**
 * The manifest.json object, in key order: `generatedBy` is the script path named in its "//" note;
 * `omittedFeatures` the features whose files this build left out (--omit-features;
 * empty ships everything).
 */
export const manifestFor = ({ generatedBy, buildId, source, catalog, sandboxAbi, pdfAbi, omittedFeatures, extensions }) => ({
  "//": `Generated by ${generatedBy} — do not edit.`,
  buildId,
  source,
  engineVersion: catalog.engineVersion,
  sandboxAbi,
  pdfAbi,
  knownComponentTypes: catalog.knownComponentTypes,
  builtinBindings: catalog.builtinBindings,
  builderThemes: catalog.builderThemes,
  formTokens: catalog.formTokens,
  omittedFeatures,
  extensions
});
