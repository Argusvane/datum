// Emits the declarations of a package that publishes to npm into its `dist/types`, with no
// reference left to a package that does not publish.
//
// The source of these packages imports the engine, the PDF kernel and the QuickJS host by their
// package names, and those are private: the bundles carry their code, but a declaration file that
// says `from "@argusvane/datum-engine"` would send a consumer looking for a package the registry
// does not have. So the declarations are emitted from the sources: tsc is told where each private
// package's sources are (a temporary tsconfig built from their `exports` maps), emits the
// declarations of everything the public entries reach, and every specifier naming a private package is
// then rewritten to the relative path of the declaration file emitted for it. What a consumer gets
// is one self-contained folder; what it needs from the registry is only what the package
// declares (the type-only imports of lit-html, pdf-lib and the like are optional peers, checked here).
//
//   node ../../scripts/npm/build-types.mjs            from a package folder
//   node scripts/npm/build-types.mjs packages/datum   from the repository root
//
// The package's own `tsconfig.build.json` says which files are the public entries (`include`) and
// the compiler options; this script overrides `rootDir` and `paths` only.
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LABEL = "build-types";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The folders of the repository's own packages (the engine and everything under packages/). */
function workspaceFolders() {
  const folders = [join(repo, "engine")];
  const packages = join(repo, "packages");
  for (const name of readdirSync(packages)) {
    if (existsSync(join(packages, name, "package.json"))) {
      folders.push(join(packages, name));
    }
  }
  return folders;
}

/**
 * The private packages of the repository and what each one's specifiers resolve to:
 * `Map<specifier, absolute .ts file>`, from the `exports` of every `private` package that
 * names a TypeScript file. A pattern entry (`./dist/*`) is skipped: nothing a declaration
 * imports goes through one.
 */
export function privateSpecifiers(self) {
  const table = new Map();
  for (const folder of workspaceFolders()) {
    if (resolve(folder) === resolve(self)) {
      continue;
    }
    const manifest = read(join(folder, "package.json"));
    if (manifest.private !== true || !manifest.name?.startsWith("@argusvane/")) {
      continue;
    }
    const exports = manifest.exports ?? { ".": manifest.types ?? manifest.main };
    for (const [key, target] of Object.entries(exports)) {
      const file = typeof target === "string" ? target : (target.types ?? target.import);
      if (typeof file !== "string" || key.includes("*") || !file.endsWith(".ts")) {
        continue;
      }
      table.set(key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`, resolve(folder, file));
    }
  }
  return table;
}

/** The package a bare specifier belongs to: `lit-html/directives/ref.js` is `lit-html`, `@scope/name/x` is `@scope/name`. */
export function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\s]+)\2/g;

/**
 * Rewrites the specifiers of one declaration file. `table` maps a private specifier to the absolute
 * declaration file emitted for it; `file` is the declaration file being read. Returns the new
 * text and the bare specifiers that remain (those no relative path replaces).
 */
export function rewriteSpecifiers(text, file, table) {
  const left = new Set();
  const missing = new Set();
  const out = text.replace(SPECIFIER, (whole, lead, quote, specifier, offset) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return whole;
    }
    // A line of a doc comment may show an import (`import { x } from "@argusvane/datum"`); it names no dependency.
    if (/^\s*(\*|\/\/)/.test(text.slice(text.lastIndexOf("\n", offset) + 1, offset))) {
      return whole;
    }
    const target = table.get(specifier);
    if (target !== undefined) {
      if (!existsSync(target)) {
        missing.add(`${specifier} -> ${target}`);
        return whole;
      }
      let path = relative(dirname(file), target).split(sep).join("/").replace(/\.d\.ts$/, ".js");
      if (!path.startsWith(".")) {
        path = `./${path}`;
      }
      return `${lead}${quote}${path}${quote}`;
    }
    if (!specifier.startsWith("node:") && !builtinModules.includes(specifier)) {
      left.add(specifier);
    }
    return whole;
  });
  return { text: out, left, missing };
}

function walk(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, found);
    } else if (name.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

function main() {
  const folder = resolve(process.argv[2] ?? process.cwd());
  const manifest = read(join(folder, "package.json"));
  const table = privateSpecifiers(folder);
  const out = join(folder, "dist", "types");
  const config = join(folder, "tsconfig.types.tmp.json");

  // Every private package's sources, where tsc looks them up: they are then source files of this
  // program, so their declarations are emitted beside the package's own (under the repository's layout).
  const paths = Object.fromEntries([...table].map(([specifier, file]) => [specifier, [file]]));
  writeFileSync(config, `${JSON.stringify({ extends: "./tsconfig.build.json", compilerOptions: { rootDir: repo, outDir: "dist/types", paths } }, null, 2)}\n`);
  rmSync(out, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, [join(folder, "node_modules", "typescript", "bin", "tsc"), "-p", config], { cwd: folder, stdio: "inherit" });
  } finally {
    rmSync(config, { force: true });
  }

  // The declaration file emitted for each private specifier: the source's place under the repository, in dist/types.
  const emitted = new Map([...table].map(([specifier, file]) => [specifier, join(out, relative(repo, file)).replace(/\.ts$/, ".d.ts")]));
  const declared = new Set(["dependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => Object.keys(manifest[key] ?? {})));
  const problems = [];
  const undeclared = new Map();
  let files = 0;
  for (const file of walk(out)) {
    const before = readFileSync(file, "utf8");
    const { text, left, missing } = rewriteSpecifiers(before, file, emitted);
    for (const entry of missing) {
      problems.push(`${relative(out, file)}: no declaration was emitted for ${entry}`);
    }
    for (const specifier of left) {
      const name = packageOf(specifier);
      if (name !== manifest.name && !declared.has(name)) {
        undeclared.set(name, relative(out, file));
      }
    }
    if (text.includes(repo)) {
      problems.push(`${relative(out, file)} names the checkout's absolute path`);
    }
    if (text !== before) {
      writeFileSync(file, text);
    }
    files += 1;
  }
  for (const [name, where] of undeclared) {
    problems.push(`${where} imports "${name}", which ${manifest.name} neither depends on nor lists as a peer (add it to peerDependencies, optional, if only types read it)`);
  }
  if (problems.length > 0) {
    console.error(`${LABEL}: ${manifest.name}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${LABEL}: ${manifest.name}: ${files} declaration files in dist/types, no private package left`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
