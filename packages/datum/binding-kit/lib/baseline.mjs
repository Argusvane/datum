// Tier-2 baselines: a type the design system has no markup for is compared
// with its own previous screenshots. The first baseline is never accepted silently.
//
//   tests/tier2/baseline/<case>.png        the accepted screenshots
//   tests/tier2/baseline/manifest.json     { format, environment, files, signOff }
//
// `files` holds the sha-256 of every PNG as it was written. `signOff` is the human's record:
// { reviewer, date, pngs: [{ file, sha256 }] }. A PNG is accepted only when the record names a
// reviewer and a date and lists that PNG with the sha-256 it has now. `--update-baseline` writes
// candidate PNGs and fills `pngs` for the reviewer to look at; it never writes `reviewer` or
// `date`, and it blanks both whenever a PNG's bytes changed since they were written, so a changed
// picture always needs a fresh look. Without a sign-off the case fails.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "manifest.json";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function baselineDir(pkg) {
  return join(pkg.testsDir, "tier2", "baseline");
}

export function emptyManifest() {
  return { format: 1, environment: {}, files: {}, signOff: { reviewer: "", date: "", pngs: [] } };
}

export function readManifest(dir) {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) return emptyManifest();
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  return { ...emptyManifest(), ...manifest, signOff: { ...emptyManifest().signOff, ...manifest.signOff } };
}

/** The status of one case's baseline: `{ state: "missing" | "unsigned" | "changed" | "signed", reason }`. */
export function baselineStatus(dir, id, manifest = readManifest(dir)) {
  const file = join(dir, `${id}.png`);
  if (!existsSync(file)) return { state: "missing", reason: `no baseline ${id}.png: write a candidate with --update-baseline, look at it, and record the sign-off in ${MANIFEST}` };
  const actual = sha256(readFileSync(file));
  const { reviewer, date, pngs } = manifest.signOff;
  const listed = (pngs ?? []).find((entry) => entry.file === `${id}.png`);
  if (!reviewer || !String(reviewer).trim() || !date || !DATE.test(String(date))) {
    return { state: "unsigned", reason: `baseline ${id}.png has no recorded sign-off (${MANIFEST}: signOff.reviewer and signOff.date, YYYY-MM-DD, are blank): a person looks at the PNG and fills them in` };
  }
  if (!listed) return { state: "unsigned", reason: `baseline ${id}.png is not in signOff.pngs of ${MANIFEST}: it was added after the last sign-off` };
  if (listed.sha256 !== actual) return { state: "changed", reason: `baseline ${id}.png changed after it was signed off (sha-256 differs from signOff.pngs): sign it off again` };
  return { state: "signed", reason: `signed off by ${reviewer} on ${date}` };
}

/**
 * Writes candidate PNGs (`pictures`: { id: Buffer }) and updates the manifest. Returns the list of
 * files written and whether the reviewer and date were blanked.
 */
export function writeCandidates(dir, pictures, environment) {
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(dir);
  const before = new Map((manifest.signOff.pngs ?? []).map((entry) => [entry.file, entry.sha256]));
  let changed = false;
  const written = [];
  for (const [id, bytes] of Object.entries(pictures)) {
    const file = `${id}.png`;
    writeFileSync(join(dir, file), bytes);
    const hash = sha256(bytes);
    manifest.files[file] = { sha256: hash };
    if (before.get(file) !== hash) changed = true;
    written.push(file);
  }
  manifest.environment = environment;
  manifest.signOff.pngs = Object.keys(manifest.files).sort().map((file) => ({ file, sha256: manifest.files[file].sha256 }));
  if (changed || !manifest.signOff.reviewer) {
    manifest.signOff.reviewer = "";
    manifest.signOff.date = "";
  }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { written, blanked: manifest.signOff.reviewer === "" };
}
