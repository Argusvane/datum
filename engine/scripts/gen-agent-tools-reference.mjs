#!/usr/bin/env node
/**
 * Writes docs/reference/agent-tools.md from the agent tool catalogues (see
 * agent-tools-reference.ts for what comes from code and what from the hand-written notes):
 *
 *   npm run docs:agent-tools          rewrite the file
 *   npm run docs:agent-tools:check    exit 1, with a summary of the difference, when the committed
 *                                     file is not what a fresh render gives
 *
 * The renderer is TypeScript and imports the engine's catalogues and the test fixtures, and the
 * engine has no vite-node, so this loads it through Vite's own module runner (`runnerImport`),
 * the same transform the test runner applies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, "..");

const { module } = await runnerImport(resolve(here, "agent-tools-reference.ts"), { root: engineRoot, configFile: false, logLevel: "error" });
const { CHECK_COMMAND, REFERENCE_PATH, REWRITE_COMMAND, diffSummary, renderAgentToolsReference } = module;

let exit = 0;
try {
  const fresh = renderAgentToolsReference();
  const committed = existsSync(REFERENCE_PATH) ? readFileSync(REFERENCE_PATH, "utf8") : "";
  if (process.argv.includes("--check")) {
    if (committed !== fresh) {
      console.error("docs/reference/agent-tools.md is stale (" + CHECK_COMMAND + ").\n" + diffSummary(committed, fresh) + "\nRun `" + REWRITE_COMMAND + "` in engine/ and commit the result.");
      exit = 1;
    } else {
      console.log("docs/reference/agent-tools.md is current.");
    }
  } else if (committed === fresh) {
    console.log("docs/reference/agent-tools.md is already current.");
  } else {
    mkdirSync(dirname(REFERENCE_PATH), { recursive: true });
    writeFileSync(REFERENCE_PATH, fresh);
    console.log("Wrote docs/reference/agent-tools.md (" + fresh.length + " characters).");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exit = 1;
}
// The fixtures leave timers and registrars behind; the script is done.
process.exit(exit);
