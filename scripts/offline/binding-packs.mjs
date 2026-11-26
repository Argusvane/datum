#!/usr/bin/env node
// Writes the offline pack of each design-system binding (lib/packs.mjs): the binding's bundle and the
// design system's files with every reference to another host answered from the pack or taken out.
//
//   npm run offline:packs                              all the reference bindings, into dist/offline/bindings/
//   npm run offline:packs -- --binding gcds --out /srv/datum/bindings
//   npm run offline:packs -- --fail-on-dropped         exit 1 when a reference had to be taken out
import { join, relative, resolve } from "node:path";
import { buildBindingPacks, REFERENCE_BINDINGS, REPO, remoteReferences } from "./lib/packs.mjs";

const LABEL = "offline:packs";
const argv = process.argv.slice(2);
const fail = (message) => {
  console.error(`${LABEL}: ${message}`);
  process.exit(1);
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: npm run offline:packs -- [options]

Options:
  --binding <id>      a binding to pack (repeatable); default: ${REFERENCE_BINDINGS.join(", ")}
  --out <dir>         where the packs go (each pack's own folder and manifest.json are replaced, nothing
                      else in the folder is touched); default: dist/offline/bindings
  --fail-on-dropped   exit 1 when a reference to another host could not be answered from the pack
  --help, -h          this text

Each binding must be installed and built first (npm install && npm run build in bindings/<id>).`);
  process.exit(0);
}
const ids = [];
let out = join(REPO, "dist", "offline", "bindings");
let failOnDropped = false;
for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at];
  const value = () => (argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[(at += 1)] : fail(`${arg} takes a value.`));
  if (arg === "--binding") ids.push(value());
  else if (arg === "--out") out = resolve(value());
  else if (arg === "--fail-on-dropped") failOnDropped = true;
  else fail(`unknown option ${arg} (--help lists them).`);
}

let manifest;
try {
  manifest = buildBindingPacks({ out, ids: ids.length > 0 ? ids : REFERENCE_BINDINGS });
} catch (error) {
  fail(error.message);
}
const left = remoteReferences(out, Object.keys(manifest));
if (left.length > 0) fail(`a packed stylesheet still names another host:\n  ${left.join("\n  ")}`);

// Shown relative to where the command ran, or in full when it is outside that folder.
const shown = relative(process.cwd(), out).startsWith("..") ? out : relative(process.cwd(), out) || ".";
let droppedTotal = 0;
for (const [id, entry] of Object.entries(manifest)) {
  droppedTotal += entry.dropped.length;
  console.log(`${LABEL}: ${shown}/${id}/  ${entry.files} files, ${entry.localized.length} reference${entry.localized.length === 1 ? "" : "s"} answered from the pack, ${entry.dropped.length} taken out`);
  const byReason = new Map();
  for (const drop of entry.dropped) byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
  for (const [reason, count] of byReason) console.log(`    taken out (${count}): ${reason}`);
}
console.log(`${LABEL}: ${shown}/manifest.json`);
if (failOnDropped && droppedTotal > 0) fail(`${droppedTotal} reference${droppedTotal === 1 ? "" : "s"} could not be answered from the packs (--fail-on-dropped).`);
