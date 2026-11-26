// Reference files and case files.
//
// A reference file is one case: bindings/<id>/reference/<case>.html is a leading comment of JSON,
// then the markup the design system's own template (or its documented example) produces for the
// form the case describes:
//
//   <!-- datum-reference
//   { "source": "govuk-frontend 6.6.0, components/input/template.njk (reference/generate.mjs)",
//     "components": [ { "id": "name", "type": "text", "configuration": { "label": "Full name" } } ],
//     "root": "form" }
//   -->
//   <form> ... </form>
//
// Keys: source (required: where the markup comes from), one of components / definition (the form
// the binding draws), preset, locale, mode, steps (what is done to the drawn binding after it is
// mounted: validate, type, focus, set, click, press, blur, settle), width (px, default 560), root
// (the selector in the markup that stands for Datum's <form>), init / initShadow (the design
// system's own start in the document, `initShadow` in the shadow root (none by default: a script that
// looks things up through `document` cannot run there), each run with `root` = the element the
// markup sits in), compareWith ("plain": hold the binding to the document picture, for a design
// system whose script changes what is drawn and cannot run in a shadow root), focus (a selector to focus
// in the markup), tolerance ({ pixels, box }), known (a reason: a documented gap between the binding and the design system; the case is reported as a known difference while it differs and fails once it stops differing), ignoreText ([{ match, reason }]: lines dropped from
// both sides, each with its reason), ignoreBoxes (the same for elements, matched on their text), skip (a reason: the case is reported, not run).
//
// A tier-2 case (a type the design system has no markup for, compared with its own previous
// screenshots) is a bare JSON file in tests/tier2/ with the same keys and no markup or source.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const OPEN = "<!-- datum-reference";

/** Wraps a list of components as the minimal form definition the suite's fixtures use. */
export function formOf(components, id = "kit") {
  return {
    id: `kit-${id}`,
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] },
    root: { id: "root", type: "form", configuration: {}, children: { content: components } }
  };
}

function check(meta, where, { tier }) {
  const problems = [];
  if (tier === 1 && (typeof meta.source !== "string" || meta.source.trim() === "")) problems.push(`${where}: "source" is required: name the DS template or documentation page the markup comes from`);
  if (!meta.components && !meta.definition) problems.push(`${where}: give "components" (a list) or "definition" (a full form)`);
  if (meta.components && !Array.isArray(meta.components)) problems.push(`${where}: "components" must be a list`);
  for (const key of ["ignoreText", "ignoreBoxes"]) {
    for (const item of meta[key] ?? []) {
      if (typeof item?.match !== "string" || typeof item?.reason !== "string" || item.reason.trim() === "") problems.push(`${where}: each ${key} entry needs "match" (a regular expression) and a "reason"`);
      else {
        try { new RegExp(item.match); } catch { problems.push(`${where}: ${key} "${item.match}" is not a regular expression`); }
      }
    }
  }
  return problems;
}

/** Parses a reference file's text. Resolves to `{ id, meta, html, problems }`. */
export function parseReference(text, id) {
  const start = text.indexOf(OPEN);
  const end = start >= 0 ? text.indexOf("-->", start) : -1;
  if (start < 0 || end < 0) return { id, meta: {}, html: text, problems: [`${id}: no leading "<!-- datum-reference { json } -->" comment`] };
  let meta;
  try {
    meta = JSON.parse(text.slice(start + OPEN.length, end));
  } catch (error) {
    return { id, meta: {}, html: text.slice(end + 3), problems: [`${id}: the datum-reference comment is not JSON (${error.message})`] };
  }
  return { id, meta, html: text.slice(end + 3).trim(), problems: check(meta, id, { tier: 1 }) };
}

/** Every reference case of a binding package, sorted by id. */
export function loadReferences(pkg) {
  if (!pkg.referenceDir || !existsSync(pkg.referenceDir)) return [];
  return readdirSync(pkg.referenceDir)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => parseReference(readFileSync(join(pkg.referenceDir, name), "utf8"), basename(name, ".html")));
}

/** Every tier-2 case of a binding package (tests/tier2/*.json), sorted by id. */
export function loadTier2(pkg) {
  const dir = pkg.testsDir ? join(pkg.testsDir, "tier2") : undefined;
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "baseline.json")
    .sort()
    .map((name) => {
      const id = basename(name, ".json");
      try {
        const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
        return { id, meta, problems: check(meta, `tier2/${id}`, { tier: 2 }) };
      } catch (error) {
        return { id, meta: {}, problems: [`tier2/${id}: not JSON (${error.message})`] };
      }
    });
}

/** The form definition of a case. */
export function definitionOf(meta, id) {
  return structuredClone(meta.definition ?? formOf(meta.components, id));
}
