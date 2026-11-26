#!/usr/bin/env node
// The command line of datum-binding-check (binding-check/cli.mjs). Plain ESM, no build step; it needs
// Playwright and esbuild only when it runs the cases (both optional peer dependencies), never to print --help or --list.
import { runBindingCheck } from "../binding-check/cli.mjs";

runBindingCheck(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`datum-binding-check: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 4;
  }
);
