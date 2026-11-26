#!/usr/bin/env node
// Turns the changelog's `## [Unreleased]` section into the section of a release: the heading becomes `## [<version>] - <date>`
// and a fresh, empty `## [Unreleased]` is left above it, so the notes written during development are the release's notes
// and the next change has a place to go. Run it in the release commit (docs/releasing.md), before the tag:
//
//   node scripts/changelog-promote.mjs --version 0.1.0 [--date 2026-12-01] [--file CHANGELOG.md]
//
// The date is today's date in UTC unless --date gives it. The script refuses a changelog with no `[Unreleased]` heading, with
// two, with an empty Unreleased section, or one that already has a section for the version, and writes nothing then. The
// Maven release script (integrations/jvm/scripts/release.mjs) refuses to run when the version's section is missing, and
// the release notes on the GitHub Release are this section.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const UNRELEASED = /^## \[Unreleased\][ \t]*$/gm;

/** The changelog text with `[Unreleased]` promoted to `version` and `date`; throws a plain message when it cannot be. */
export const promote = (text, version, date) => {
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" is not a version (x.y.z or x.y.z-pre)`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`"${date}" is not a date (YYYY-MM-DD)`);
  }
  const headings = [...text.matchAll(UNRELEASED)];
  if (headings.length !== 1) {
    throw new Error(`expected one "## [Unreleased]" heading, found ${headings.length}`);
  }
  if (new RegExp(`^## \\[${version.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}\\]`, "m").test(text)) {
    throw new Error(`the changelog already has a section for ${version}`);
  }
  const start = headings[0].index + headings[0][0].length;
  const next = text.slice(start).search(/^## \[/m);
  const body = next === -1 ? text.slice(start) : text.slice(start, start + next);
  if (body.trim() === "") {
    throw new Error("the Unreleased section is empty; there is nothing to release");
  }
  return `${text.slice(0, headings[0].index)}## [Unreleased]\n\n## [${version}] - ${date}${text.slice(start)}`;
};

const main = () => {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const version = option("--version");
  if (version === undefined) {
    console.error("changelog-promote: --version <x.y.z> is required.");
    process.exit(1);
  }
  const file = option("--file") ?? join(repo, "CHANGELOG.md");
  const date = option("--date") ?? new Date().toISOString().slice(0, 10);
  try {
    writeFileSync(file, promote(readFileSync(file, "utf8"), version, date));
  } catch (error) {
    console.error(`changelog-promote: ${error.message}; ${file} is unchanged.`);
    process.exit(1);
  }
  console.log(`changelog-promote: ${file} now has "## [${version}] - ${date}".`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
