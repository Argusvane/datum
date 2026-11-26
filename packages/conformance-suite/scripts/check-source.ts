// Builds the sandbox program from the repository's source (buildSandboxProgram) and runs the suite
// over it: the only place the program is built, because buildSandboxProgram splices
// Function.prototype.toString() of kernel functions and must never go through a transforming bundler.
// Runs under vite-node, like packages/datum/scripts/write-sandbox-program.ts.
//   npm run check:source -- [any datum-security-check option except --program]
import { buildSandboxProgram } from "@argusvane/datum-quickjs-wasm-host";

import { runCli } from "../src/cli.js";
import { programFromText } from "../src/runners/program/load-program.js";

const code = await runCli(process.argv.slice(2), { stdout: (text) => void process.stdout.write(text), stderr: (text) => void process.stderr.write(text) }, {
  builtProgram: () => programFromText(buildSandboxProgram(), "(built from source)", "built")
});
process.exitCode = code;
