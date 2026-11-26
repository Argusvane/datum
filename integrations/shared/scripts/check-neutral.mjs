// Fails when a file under integrations/shared names a host. The tree is the part of every host's build
// that is the same bytes everywhere, so a host's name in it means one host leaked into the others'
// inputs. Plain node, no dependencies; run with `npm run shared:check-neutral`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Word-bounded so "nested" and "javascript" pass; the host list is every integration the repository has or plans.
const HOSTS = /\b(drupal|php|symfony|laravel|wordpress|spring|jvm|django|fastapi|nestjs|asp\.net|dotnet|express)\b/i;
// This script lists the names it hunts for, and pin-runtime.mjs writes each host's runtime pin, so it must name
// the hosts whose files it writes; those two are the only exemptions.
const EXEMPT = new Set(["scripts/check-neutral.mjs", "scripts/pin-runtime.mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BINARY = /\.(gz|zip|wasm|png|jpg|jpeg|gif|woff2?|ttf|otf|pdf|ico)$/i; // binary fixtures are not prose

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : files(join(dir, e.name))) : [join(dir, e.name)],
  );

const hits = [];
for (const file of files(root)) {
  const rel = relative(root, file).split("\\").join("/");
  if (EXEMPT.has(rel)) continue;
  if (BINARY.test(rel)) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const m = HOSTS.exec(line);
    if (m) hits.push(`${rel}:${i + 1}: names a host (${m[0]})`);
  });
}
if (hits.length > 0) {
  console.error(`shared:check-neutral: ${hits.length} line(s) under integrations/shared name a host:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log("shared:check-neutral: integrations/shared names no host");
