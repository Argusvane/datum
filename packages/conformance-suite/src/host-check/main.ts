// The command line's entry: dist/host-check.mjs is this file bundled (scripts/build-cli.mjs), run by
// bin/datum-host-check.mjs. Nothing here needs a TypeScript toolchain at run time.
import { runHostCheckCli } from "./cli.js";

process.exitCode = await runHostCheckCli(process.argv.slice(2));
