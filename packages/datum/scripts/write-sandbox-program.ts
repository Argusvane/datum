// Writes the sandbox program to dist/datum-sandbox-program.js: the portable kernel with
// its __datum_register / __datum_run entry points — the very text datum-wasm.js evaluates in QuickJS
// in the browser — as one plain script for a server that re-validates submissions in a QuickJS of
// its own. Run by `npm run build` through
// vite-node, which reads the workspace's TypeScript sources the way the bundler does.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { buildSandboxProgram } from "@argusvane/datum-quickjs-wasm-host";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(dist, { recursive: true });

const banner = [
  `/* Datum sandbox program (ABI ${WASM_ABI_VERSION}). Evaluate once in a QuickJS context; register each plugin`,
  "   module with __datum_register(<the module's completion value>); then, per submission, call",
  "   __datum_run(contextJson) — { formId, form, values, locale?, externalData?, unknownFields?, logLevel?, journey? } — and parse",
  "   the outcome it returns: { errors, values?, logs? }. To ask about a definition, call",
  "   __datum_inspect(requestJson) — { abi, op: \"public\" | \"check\" | \"inspect\", definition, formulaErrors? } — and parse",
  "   its answer: { ok: true, op, ... } or { ok: false, error: { code, message } }. Built by @argusvane/datum. */"
].join("\n");
writeFileSync(join(dist, "datum-sandbox-program.js"), `${banner}\n${buildSandboxProgram()}\n`);
console.log("write-sandbox-program: dist/datum-sandbox-program.js");
