#!/usr/bin/env node
/**
 * Generates the attribute reference:
 *   docs/reference/attributes.md    the human reference
 *   docs/reference/attributes.json  the machine source of truth
 *
 * The docs site's element pages take their tables from attributes.json (site/scripts/gen-docs-reference.mjs).
 *
 * Where the attribute NAMES come from: the observedAttributes arrays of DatumFormElement and
 * DatumFormBuilderElement, read as SOURCE TEXT with a regex. The
 * classes extend HTMLElement and need a DOM to import, and a generator that boots jsdom plus the
 * whole engine to read two string lists would be slower and more fragile than the list is. The
 * price is that the arrays must stay plain string literals (the check fails loudly if one stops
 * being readable). Descriptions, defaults and categories are hand-written in
 * attribute-metadata.mjs.
 *
 * `--check` fails (exit 1) when an observed attribute has no metadata, a metadata entry names an
 * attribute nothing observes (entries marked "pending" are exempt until their source lands), or a
 * generated file differs from the committed one. Without the flag the files are written.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILDER_ATTRIBUTES,
  EVENTS,
  FORM_ATTRIBUTES,
  JS_ONLY,
  METHODS,
  THEMES_NOTE
} from "./attribute-metadata.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
export const MD_PATH = join(REPO_ROOT, "docs/reference/attributes.md");
export const JSON_PATH = join(REPO_ROOT, "docs/reference/attributes.json");

const SOURCE_FILES = {
  form: join(PACKAGE_ROOT, "src/form-element.ts"),
  builder: join(PACKAGE_ROOT, "src/builder-element.ts")
};

/** The string literals of the observedAttributes array in `text`; throws when it is not readable. */
export function readObserved(text, label) {
  const match = /observedAttributes\(\)\s*:\s*string\[\]\s*\{\s*return\s*\[([\s\S]*?)\]\s*;/.exec(text);
  if (!match) {
    throw new Error(`${label}: no readable observedAttributes array`);
  }
  const body = match[1];
  const names = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(`${label}: observedAttributes has no string literals`);
  }
  return { names };
}

/** The observed attribute names per element, from source texts keyed form/builder. */
export function observedFrom(sources) {
  const form = readObserved(sources.form, "form-element").names;
  const builder = readObserved(sources.builder, "builder-element").names;
  return { form, builder };
}

function readSources() {
  return {
    form: readFileSync(SOURCE_FILES.form, "utf8"),
    builder: readFileSync(SOURCE_FILES.builder, "utf8")
  };
}

/** Checks (a) and (b): observed attributes without metadata, and metadata nothing observes. */
export function metadataProblems(observed, metadata = { form: FORM_ATTRIBUTES, builder: BUILDER_ATTRIBUTES }) {
  const problems = [];
  for (const [element, names] of [["form", observed.form], ["builder", observed.builder]]) {
    const table = metadata[element];
    for (const name of names) {
      if (!table[name]) {
        problems.push(`${element}: observed attribute "${name}" has no entry in attribute-metadata.mjs`);
      }
    }
    for (const [name, row] of Object.entries(table)) {
      if (!names.includes(name) && !row.pending) {
        problems.push(`${element}: metadata entry "${name}" names an attribute no class observes (stale)`);
      }
    }
  }
  return problems;
}

/** The rows to publish per element: observed ones only, in source order (pending entries appear once observed). */
export function rowsFor(observed, metadata = { form: FORM_ATTRIBUTES, builder: BUILDER_ATTRIBUTES }) {
  const pick = (names, table) => names.filter((name) => table[name]).map((name) => ({ attribute: name, ...table[name] }));
  return {
    "datum-form": pick(observed.form, metadata.form),
    "datum-form-builder": pick(observed.builder, metadata.builder)
  };
}

function stripPending(row) {
  const { pending: _pending, ...rest } = row;
  return rest;
}

export function renderJson(rows) {
  const document = {
    generatedBy: "packages/datum/scripts/gen-attribute-reference.mjs",
    note: "Generated. Edit scripts/attribute-metadata.mjs and run the generator; never edit by hand.",
    themes: THEMES_NOTE,
    elements: Object.fromEntries(Object.entries(rows).map(([element, list]) => [element, list.map(stripPending)])),
    jsOnly: JS_ONLY,
    methods: METHODS,
    events: Object.fromEntries(Object.entries(EVENTS).map(([element, list]) => [element, list.map(([name, description]) => ({ name, description }))]))
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

function mdTable(list) {
  const lines = ["| Attribute | JS property | Values | Default | Cat. | Notes |", "|---|---|---|---|---|---|"];
  for (const row of list) {
    lines.push(`| \`${row.attribute}\` | \`${cell(row.prop)}\` | ${cell(row.values)} | ${cell(row.default)} | ${row.category} | ${cell(row.notes)} |`);
  }
  return lines.join("\n");
}

export function renderMarkdown(rows) {
  const out = [];
  out.push("# Attribute reference", "");
  out.push("Generated by `packages/datum/scripts/gen-attribute-reference.mjs` from the elements' `observedAttributes` and `scripts/attribute-metadata.mjs`. Do not edit by hand; `node scripts/gen-attribute-reference.mjs --check` fails when this file is stale. The machine form is `attributes.json`.", "");
  out.push("Categories: **R** required, **D** sensible default, **O** opt-in, **J** the attribute carries the declarative part and a JS property carries the rest (functions, custom objects).", "");
  out.push("## Themes", "", THEMES_NOTE, "");
  out.push("## `<datum-form>`", "", mdTable(rows["datum-form"]), "");
  out.push("## `<datum-form-builder>`", "", mdTable(rows["datum-form-builder"]), "");
  out.push("## JS-only configuration", "", "| Element | Properties | Notes |", "|---|---|---|");
  for (const item of JS_ONLY) {
    out.push(`| \`${item.element}\` | \`${cell(item.prop)}\` | ${cell(item.notes)} |`);
  }
  out.push("");
  out.push("## Methods and events", "");
  for (const element of Object.keys(METHODS)) {
    out.push(`### \`${element}\` methods`, "", METHODS[element].map((name) => `\`${name}\``).join(", "), "");
  }
  for (const element of Object.keys(EVENTS)) {
    out.push(`### \`${element}\` events`, "", "| Event | When |", "|---|---|");
    for (const [name, description] of EVENTS[element]) {
      out.push(`| \`${name}\` | ${cell(description)} |`);
    }
    out.push("");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Everything the generator owns, as path -> text. */
export function generate(sources = readSources()) {
  const observed = observedFrom(sources);
  const rows = rowsFor(observed);
  return {
    problems: metadataProblems(observed),
    files: new Map([
      [MD_PATH, renderMarkdown(rows)],
      [JSON_PATH, renderJson(rows)]
    ])
  };
}

/** The list of failures check mode reports; empty when everything is current. */
export function checkAll(sources = readSources()) {
  const { problems, files } = generate(sources);
  const failures = [...problems];
  for (const [path, text] of files) {
    const committed = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (committed !== text) {
      failures.push(`${path} is stale: run \`node scripts/gen-attribute-reference.mjs\` in packages/datum`);
    }
  }
  return failures;
}

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const failures = checkAll();
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(failure);
      }
      process.exit(1);
    }
    console.log("attribute reference is current");
    return;
  }
  const { problems, files } = generate();
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    process.exit(1);
  }
  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
