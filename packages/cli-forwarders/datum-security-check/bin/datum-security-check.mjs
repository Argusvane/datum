#!/usr/bin/env node
// Forwards to the command of the scoped package this one stands for (see README.md): finds that package
// beside this one, reads which file its `bin` names for `datum-security-check`, and runs it in this process, with this
// process's arguments, input, output and exit code. Nothing else lives here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SCOPED = "@argusvane/datum-conformance-suite";
const COMMAND = "datum-security-check";

let target;
try {
  const manifest = createRequire(import.meta.url).resolve(`${SCOPED}/package.json`);
  target = join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin[COMMAND]);
} catch (error) {
  process.stderr.write(`${COMMAND}: cannot find ${SCOPED}, which this package forwards to (${error.message}). Run: npx --package ${SCOPED} ${COMMAND}\n`);
  process.exit(4);
}
await import(pathToFileURL(target).href);
