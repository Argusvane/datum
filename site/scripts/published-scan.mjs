// What may never be in public/demo/, whoever copied it there: the binding pages' files
// (copy-binding-assets.mjs). It ends with this scan over the
// whole folder, and test/binding-pages.test.ts runs it over what is there.
//
//   - GDS Transport: a file named for it or for its faces, an @font-face rule that names it;
//   - the government marks the copies leave out: the GOV.UK crest, the Government of Québec
//     signature, the Ontario logo and supergraphic, any favicon (Ontario's trillium, the USWDS and
//     GOV.UK icons), the Government of Canada
//     signature and wordmark artwork in the GCDS bundle, the Government of Alberta header logos.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every file below a folder, as paths relative to it ('/'-separated). */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join("/")];
  });
}

/** File names no copy may publish. */
export const NEVER_PUBLISHED_NAMES = [
  [/(^|\/)(light|bold)-[0-9a-f]{10}-v\d\.woff2?$/, "a GDS Transport face"],
  [/gds[-_ ]?transport/i, "a file named for GDS Transport"],
  [/govuk-crest/i, "the GOV.UK crest"],
  [/QUEBEC_(blanc|couleur)/, "the Government of Québec signature"],
  [/ontario-logo|supergraphic|favicon/i, "a government's logo, favicon or supergraphic"]
];

/** Text no copied stylesheet or script may hold. */
export const NEVER_PUBLISHED_TEXT = [
  [/\.css$/, /@font-face\s*\{[^}]*GDS Transport/i, "an @font-face rule for GDS Transport"],
  [/\.css$/, /govuk-crest/, "a reference to the GOV.UK crest"],
  // The GC signature or wordmark with artwork after its title (the copies keep the title only).
  [/\.js$/, /aria-labelledby="(?:wordmark|signature)-(?:en|fr)-title">(?:\\n|\\t)*<title[\s\S]*?<\/title>(?!<\/svg>)\s*(?:\\n|\\t)*</, "the Government of Canada signature or wordmark"],
  // The two Alberta header logos, inline as svg data.
  [/\.js$/, /PHN2ZyB3aWR0aD0i(?:MTE4IiBoZWlnaHQ9IjMyIiB2aWV3|MzIiIGhlaWdodD0iMzIiIHZpZXdC)/, "a Government of Alberta header logo"]
];

/** What in `dir` breaks the rules above, as "path: what" lines; empty when nothing does. */
export function scanPublished(dir) {
  const problems = [];
  for (const path of walk(dir)) {
    for (const [pattern, what] of NEVER_PUBLISHED_NAMES) if (pattern.test(path)) problems.push(`${path}: ${what}`);
    const texts = NEVER_PUBLISHED_TEXT.filter(([file]) => file.test(path));
    if (texts.length === 0) continue;
    const text = readFileSync(join(dir, path), "utf8");
    for (const [, pattern, what] of texts) if (pattern.test(text)) problems.push(`${path}: ${what}`);
  }
  return problems;
}
