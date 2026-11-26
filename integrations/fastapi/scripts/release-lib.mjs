// Pure helpers of the release script: the members, their versions, the sibling "==" pins and the check that
// every pin equals the member it names. No process is started here; release.mjs and the pin test both import this file.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FASTAPI_ROOT = join(here, "..");
export const PACKAGES_ROOT = join(FASTAPI_ROOT, "packages");

// PEP 440 release, optional pre/post/dev segments (no epoch, no local part: neither can be published).
export const VERSION_PATTERN = /^\d+(\.\d+)*((a|b|rc)\d+)?(\.post\d+)?(\.dev\d+)?$/;

// A sibling pin as written in a dependency string: argusvane-datum-core==0.1.0 or argusvane-datum-core[aio]==0.1.0 (quotes close the match).
const PIN = /\b(argusvane-datum-[a-z0-9-]+)(\[[^\]]*\])?==([^\s",\]]+)/g;

/** The `[project]` table's static version, or undefined. */
export const projectVersion = (toml) => {
  const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml);
  return project ? /^version\s*=\s*"([^"]+)"/m.exec(project[1])?.[1] : undefined;
};

/** Every member under `packagesRoot`: { name, dir, pyproject, version, text }, sorted by directory name. */
export const readMembers = (packagesRoot = PACKAGES_ROOT) =>
  readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "pyproject.toml")))
    .map((entry) => {
      const dir = join(packagesRoot, entry.name);
      const pyproject = join(dir, "pyproject.toml");
      const text = readFileSync(pyproject, "utf8");
      return { name: entry.name, dir, pyproject, text, version: projectVersion(text) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

/** The "==" pins in a pyproject's text: [{ name, extras, version }]. */
export const findPins = (text) => [...text.matchAll(PIN)].map((match) => ({ name: match[1], extras: match[2] ?? "", version: match[3] }));

/** The text with every sibling "==" pin set to `version`; pins naming something that is not a member are left alone. */
export const rewritePins = (text, memberNames, version) =>
  text.replace(PIN, (whole, name, extras = "") => (memberNames.includes(name) ? `${name}${extras}==${version}` : whole));

/**
 * The problems found in a set of members: a member without a static version, a version other than `expected` (when given),
 * two members at different versions, a pin naming a non-member, or a pin that is not its member's version. Empty = consistent.
 */
export const pinProblems = (members, expected) => {
  const problems = [];
  const byName = new Map(members.map((member) => [member.name, member]));
  for (const member of members) {
    if (member.version === undefined) {
      problems.push(`${member.name}: no static [project] version`);
    } else if (expected !== undefined && member.version !== expected) {
      problems.push(`${member.name}: version ${member.version}, expected ${expected}`);
    }
  }
  const versions = new Set(members.map((member) => member.version));
  if (expected === undefined && versions.size > 1) {
    problems.push(`members disagree on the version: ${[...versions].join(", ")}`);
  }
  for (const member of members) {
    for (const pin of findPins(member.text)) {
      const target = byName.get(pin.name);
      if (target === undefined) {
        problems.push(`${member.name}: pins ${pin.name}, which is not a member`);
      } else if (pin.version !== target.version) {
        problems.push(`${member.name}: pins ${pin.name}${pin.extras}==${pin.version}, but ${pin.name} is ${target.version}`);
      }
    }
  }
  return problems;
};
