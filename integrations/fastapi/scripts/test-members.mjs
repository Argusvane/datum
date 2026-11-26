// Every member's tests, two ways at once: the suites that take minutes run their unmarked bulk under
// pytest-xdist and their `runtime`, `openssl` and `server` tests in one quiet process afterwards; the suites that take seconds
// run as they are. The workspace is synced once before (`npm run fastapi:test`); this never syncs.
//
//   node scripts/test-members.mjs [--workers N] [--print] [member...]
//
// `--workers` is the xdist worker count for each parallel member (default: half the cores, at least 2, so the two parallel
// members' bulks share the machine); `--print` writes the plan and runs nothing. On 8 cores: argusvane-datum-core
// 16 min serial, 6 min for the bulk under 4 workers plus 4 min 48 s for the 125 marked tests.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(HERE, "..");

/** The members whose suites take minutes; the rest finish in seconds and would pay the workers' start-up for nothing. */
export const PARALLEL_MEMBERS = new Set(["argusvane-datum-core", "argusvane-datum-fastapi"]);
/** The markers the members' conftests keep off xdist workers: the wasm runtime, the openssl binary, a server process. */
export const SERIAL_MARKERS = "runtime or openssl or server";

export function defaultWorkers(cores = cpus().length) {
  return Math.max(2, Math.floor(cores / 2));
}

/**
 * The commands for the given members: `{ member, pass, args }` with `args` the `uv run` argument list, in two phases. Phase 1
 * is every bulk and every small member, phase 2 the marked tests of the parallel members (quiet: nothing else runs beside them).
 */
export function plan(members, workers) {
  const uv = (member, ...rest) => ["run", "--frozen", "--no-sync", "--package", member, "pytest", `packages/${member}`, ...rest];
  const first = [];
  const second = [];
  for (const member of members) {
    if (PARALLEL_MEMBERS.has(member)) {
      first.push({ member, pass: "bulk", args: uv(member, "-n", String(workers), "-m", `not (${SERIAL_MARKERS})`) });
      second.push({ member, pass: "marked", args: uv(member, "-p", "no:randomly", "-m", SERIAL_MARKERS) });
    } else {
      first.push({ member, pass: "all", args: uv(member) });
    }
  }
  return [first, second];
}

export function readMemberNames() {
  return readdirSync(join(WORKSPACE, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(WORKSPACE, "packages", entry.name, "pyproject.toml")))
    .map((entry) => entry.name)
    .sort();
}

function parseArgs(argv) {
  const options = { workers: defaultWorkers(), print: false, members: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workers") {
      options.workers = Number.parseInt(argv[++i], 10);
      if (!Number.isInteger(options.workers) || options.workers < 1) throw new Error("--workers takes a positive integer");
    } else if (arg === "--print") {
      options.print = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.members.push(arg);
    }
  }
  if (options.members.length === 0) options.members = readMemberNames();
  return options;
}

function run(step) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("uv", step.args, { cwd: WORKSPACE, stdio: "inherit" });
    child.on("error", (error) => resolve({ ...step, code: 1, seconds: 0, error: error.message }));
    child.on("exit", (code, signal) => resolve({ ...step, code: code ?? 1, signal, seconds: (Date.now() - started) / 1000 }));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const phases = plan(options.members, options.workers);
  if (options.print) {
    for (const [index, phase] of phases.entries()) {
      for (const step of phase) console.log(`phase ${index + 1}  ${step.member} (${step.pass}): uv ${step.args.join(" ")}`);
    }
    return 0;
  }
  const results = [];
  for (const phase of phases) {
    results.push(...(await Promise.all(phase.map(run))));
  }
  console.log("\nmember tests:");
  for (const result of results) {
    const outcome = result.code === 0 ? "ok" : `exit ${result.code}${result.signal ? ` (${result.signal})` : ""}`;
    console.log(`  ${result.member.padEnd(24)} ${result.pass.padEnd(7)} ${String(Math.round(result.seconds)).padStart(5)}s  ${outcome}${result.error ? `: ${result.error}` : ""}`);
  }
  return results.every((result) => result.code === 0) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    }
  );
}
