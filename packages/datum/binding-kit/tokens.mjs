// The token contract pattern, shown on GCDS and available to any binding that
// draws from design-system custom properties: a `tokens.json` in the package lists, for every
// custom property its tier-2 CSS, print theme and PDF theme use, the property's name and unit; a
// test checks each against the pinned release's own CSS; the PDF converter refuses units other
// than px, rem and pt (lib/token-units.mjs); a print theme's selfCheck requires the listed tokens.
// No generic DTCG reader: the contract is a flat list, the release's CSS is the authority.
//
//   {
//     "generatedFrom": { "package": "@gcds-core/tokens", "version": "1.6.0" },
//     "tokens": [ { "name": "--gcds-text-primary", "unit": "color" }, { "name": "--gcds-spacing-300", "unit": "rem" } ],
//     "inferred": [ { "name": "pdf.page.margin", "unit": "pt", "reason": "INFERRED: GCDS publishes no print tokens; Datum's choice" } ]
//   }
//
// `generatedFrom` is the block generated values (a PDF theme's numbers) carry; what the design
// system does not publish is listed under `inferred`, outside that block, with its reason, so a
// reader never mistakes a choice for a token. Run as a check:
//
//   node binding-kit/tokens.mjs --binding gcds     (also a step of kit:check where tokens.json exists)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { UNITS, unitOf } from "./lib/token-units.mjs";
import { resolveBinding } from "./lib/binding-package.mjs";

export { UNITS, TokenUnitError, lengthToPt, missingTokens, unitOf } from "./lib/token-units.mjs";

const NAME = /^--[a-z][\w-]*$/i;

/** Reads and validates a tokens.json; throws one error naming every problem. */
export function loadTokenContract(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const problems = contractProblems(doc);
  if (problems.length > 0) throw new Error(`${file}: ${problems.join("; ")}`);
  return doc;
}

export function contractProblems(doc) {
  const problems = [];
  const from = doc?.generatedFrom;
  if (!from || typeof from.package !== "string" || !from.package || typeof from.version !== "string" || !from.version) problems.push('"generatedFrom" must be { package, version }');
  if (!Array.isArray(doc?.tokens) || doc.tokens.length === 0) problems.push('"tokens" must be a list of { name, unit }');
  const seen = new Set();
  for (const entry of doc?.tokens ?? []) {
    if (typeof entry?.name !== "string" || !NAME.test(entry.name)) problems.push(`token name ${JSON.stringify(entry?.name)} is not a custom property (--name)`);
    else if (seen.has(entry.name)) problems.push(`token ${entry.name} is listed twice`);
    else seen.add(entry.name);
    if (!UNITS.includes(entry?.unit)) problems.push(`token ${entry?.name}: unit ${JSON.stringify(entry?.unit)} is not one of ${UNITS.join(", ")}`);
  }
  for (const entry of doc?.inferred ?? []) {
    if (typeof entry?.name !== "string" || typeof entry?.reason !== "string" || !/^INFERRED/.test(entry.reason)) problems.push(`inferred entry ${JSON.stringify(entry?.name)} needs a "reason" that starts with INFERRED`);
    if (entry?.unit !== undefined && !UNITS.includes(entry.unit)) problems.push(`inferred entry ${entry.name}: unit ${JSON.stringify(entry.unit)} is not one of ${UNITS.join(", ")}`);
  }
  return problems;
}

/** The custom properties a text reads through var(), as a Set of names. */
export function varsUsed(text) {
  const names = new Set();
  for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) names.add(match[1]);
  return names;
}

/** The first declaration of each custom property in a CSS text: `{ "--name": "value" }`. */
export function declarationsOf(css) {
  const out = {};
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?:!important\s*)?(?=;|})/g)) {
    if (!(match[1] in out)) out[match[1]] = match[2];
  }
  return out;
}

/** A declared value with var() references followed through the release's own declarations (a few levels). */
function resolved(value, declared, depth = 0) {
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(value.trim());
  if (!ref || depth > 6) return value;
  const next = declared[ref[1]];
  return next === undefined ? value : resolved(next, declared, depth + 1);
}

/**
 * Checks a contract against what uses it and the release it names.
 *   `sources`   the text of every file that reads the tokens (tier-2 CSS, print theme, PDF theme)
 *   `releaseCss` the pinned release's CSS (the files that declare the custom properties)
 * Problems: a var() the sources read that the contract does not list, a listed token no source
 * reads, a listed token the release does not declare, a unit that is not what the release's value is.
 */
export function checkContract({ contract, sources, releaseCss }) {
  const problems = [];
  const used = new Set();
  for (const text of sources) for (const name of varsUsed(text)) used.add(name);
  const declared = {};
  for (const css of releaseCss) Object.assign(declared, declarationsOf(css));
  const listed = new Map(contract.tokens.map((entry) => [entry.name, entry]));
  for (const name of used) {
    // A custom property the binding's own CSS defines (the --datum-* family) is not the design system's.
    if (!listed.has(name) && declared[name] !== undefined) problems.push(`${name} is read by the binding and declared by the release, but tokens.json does not list it`);
  }
  for (const entry of contract.tokens) {
    if (!used.has(entry.name)) problems.push(`${entry.name} is listed in tokens.json but nothing reads it`);
    const value = declared[entry.name];
    if (value === undefined) {
      problems.push(`${entry.name} is not declared by the pinned release (${contract.generatedFrom.package}@${contract.generatedFrom.version})`);
      continue;
    }
    if (entry.unit !== "any") {
      const actual = unitOf(resolved(value, declared));
      if (actual !== entry.unit) problems.push(`${entry.name}: tokens.json says ${entry.unit}, the release's value "${value}" is ${actual}`);
    }
  }
  return problems;
}

function files(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, filter, out);
    else if (filter(name)) out.push(path);
  }
  return out;
}

/** Runs the contract check for a binding package: its src/, print/ and pdf/ against the release CSS its tokens.json names. */
export function checkBindingTokens(pkg) {
  const file = join(pkg.dir, "tokens.json");
  if (!existsSync(file)) return { applicable: false, problems: [] };
  const contract = loadTokenContract(file);
  const sources = ["src", "print", "pdf"].flatMap((folder) => files(join(pkg.dir, folder), (name) => /\.(ts|mjs|js|css)$/.test(name))).map((path) => readFileSync(path, "utf8"));
  const packageDir = Object.keys(pkg.manifest?.devDependencies ?? {}).find((alias) => pkg.manifest.devDependencies[alias] === `npm:${contract.generatedFrom.package}@${contract.generatedFrom.version}`);
  if (!packageDir) return { applicable: true, problems: [`package.json pins no alias for ${contract.generatedFrom.package}@${contract.generatedFrom.version} (the version tokens.json says it was generated from)`], contract };
  const releaseRoot = join(pkg.dir, "node_modules", packageDir);
  const releaseCss = files(releaseRoot, (name) => name.endsWith(".css")).map((path) => readFileSync(path, "utf8"));
  if (releaseCss.length === 0) return { applicable: true, problems: [`no CSS under ${releaseRoot}: run npm install in the package`], contract };
  return { applicable: true, problems: checkContract({ contract, sources, releaseCss }), contract };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--binding");
  if (at < 0 || !process.argv[at + 1]) {
    console.error("usage: node binding-kit/tokens.mjs --binding <id|path>");
    process.exitCode = 2;
  } else {
    const pkg = resolveBinding(process.argv[at + 1]);
    const result = checkBindingTokens(pkg);
    if (!result.applicable) {
      console.log(`tokens ${pkg.id}: no tokens.json (the token contract is a pattern shown on GCDS; other bindings need not have one)`);
    } else if (result.problems.length === 0) {
      console.log(`tokens ${pkg.id}: ${result.contract.tokens.length} token(s) checked against ${result.contract.generatedFrom.package}@${result.contract.generatedFrom.version}`);
    } else {
      for (const problem of result.problems) console.log(`  FAIL ${problem}`);
      console.log(`tokens ${pkg.id}: ${result.problems.length} problem(s)`);
      process.exitCode = 1;
    }
  }
}
