#!/usr/bin/env node
// kit:check: everything the kit asks of a binding, in one command.
//
//   node binding-kit/check.mjs --binding govuk            (a binding package's `npm run kit:check`)
//   node binding-kit/check.mjs --binding datum            (Datum's own binding: `npm run kit:check:datum` in packages/datum)
//
// Steps, in order:
//   package      datumBinding is complete ({ id, designSystem, release, bundle, global, budgetKb })
//   build        the bundle builds, imports nothing, carries no lit-html, fits budgetKb      (packages only)
//   tokens       tokens.json against the pinned release's CSS                  (where the package has one)
//   equality     the drawing against the design system's own markup (reference/, tests/tier2/)  (packages only)
//   behaviour    back/forward, autofill, host element moved in the DOM (a case listed under `known` in binding-check.json
//                is reported as known while it fails, and the step exits 0 when only known cases are left)
//   checks       the package's own checks (datumBinding.checks: scripts run as node <script> --port <n>)  (packages only;
//                Chromium only: under --browser firefox or webkit the step says so and runs nothing)
//   conformance  datum-binding-check, the conformance suite's command
//
// Datum is the reference, not a design system: it has no package, bundle or reference, so its run is
// behaviour and conformance. Exit: 0 everything passed; otherwise the most serious step's code
// (4 internal, 3 preflight, 1 a case failed, 2 usage or nothing asserted).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PreflightError, readRouting } from "@argusvane/datum-conformance-suite/binding-check";
import { knownOf, runBehaviour } from "./behaviour.mjs";
import { buildBinding } from "./build.mjs";
import { conformanceTarget, runConformance } from "./conformance.ts";
import { runEquality } from "./equality.mjs";
import { resolveBinding } from "./lib/binding-package.mjs";
import { pickPort } from "./lib/ports.mjs";
import { openSession } from "./lib/session.mjs";
import { checkBindingTokens } from "./tokens.mjs";

export const USAGE = `kit:check: everything the binding kit asks of a binding

Usage
  node binding-kit/check.mjs --binding <datum | id | package path> [options]

  --skip <steps>      steps to leave out: package, build, tokens, binding, equality, behaviour, checks, conformance
  --only <steps>      run only these steps
  --update-baseline   write candidate tier-2 baselines (never a sign-off) during equality
  --report <dir>      equality.json, behaviour.json and conformance/ (report.json, junit.xml, report.html)
  --browser <name>    chromium (default), firefox or webkit
  --port <n>          first port to try (default: the first free one of 5200-5219)
Exit: 0 pass; else the most serious step's code (4 internal, 3 preflight, 1 failed, 2 usage or nothing asserted).`;

const STEPS = ["package", "build", "tokens", "binding", "equality", "behaviour", "checks", "conformance"];

/** Runs one of the package's own check scripts with node, its output passed to `log`; resolves to its exit code. */
function runScript(file, args, cwd, log) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const pass = (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) log(`  ${line}`);
    };
    child.stdout.on("data", pass);
    child.stderr.on("data", pass);
    child.on("error", (error) => { log(`  ${error.message}`); resolveExit(4); });
    child.on("close", (code) => { if (rest) log(`  ${rest}`); resolveExit(code ?? 4); });
  });
}
const RANK = { 4: 5, 3: 4, 1: 3, 2: 2, 0: 0 };

/** Runs the steps. Resolves to `{ exit, steps: [{ step, exit, note }] }`. */
export async function runCheck(binding, options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const pkg = typeof binding === "string" ? resolveBinding(binding) : binding;
  const wanted = (step) => (!options.only?.length || options.only.includes(step)) && !(options.skip ?? []).includes(step);
  const steps = [];
  const record = (step, exit, note) => {
    steps.push({ step, exit, note });
    log(`== ${step}: ${exit === 0 ? "ok" : `exit ${exit}`}${note ? ` (${note})` : ""}\n`);
  };
  log(`kit:check ${pkg.id}${pkg.config?.release ? ` (${pkg.config.designSystem} ${pkg.config.release})` : ""}\n`);

  if (wanted("package")) {
    if (pkg.isDatum) record("package", 0, "datum is an engine binding, not a package");
    else {
      for (const problem of pkg.problems) log(`  FAIL ${problem}`);
      if (!pkg.entry) log("  FAIL no binding module (src/index.ts or src/binding.ts, or \"binding\" in binding-check.json)");
      let routingProblem;
      // routes, network and known: a `known` id that matches no case of the behaviour suite or the conformance suite is a problem here, where both are at hand.
      try { readRouting(pkg.assets, pkg.assetsFile); knownOf(pkg); } catch (error) { routingProblem = error.message; log(`  FAIL ${routingProblem}`); }
      record("package", pkg.problems.length === 0 && pkg.entry && !routingProblem ? 0 : 1);
    }
  }
  if (wanted("build") && !pkg.isDatum) {
    if (pkg.problems.length > 0) record("build", 1, "the package block is incomplete");
    else {
      const { outputs, problems } = await buildBinding(pkg);
      for (const o of outputs) log(`  ${o.file.padEnd(18)} ${String(o.bytes).padStart(7)} B  ${String(o.gzip).padStart(6)} B gzip (budget ${pkg.config.budgetKb} KB)`);
      for (const problem of problems) log(`  FAIL ${problem}`);
      record("build", problems.length === 0 ? 0 : 1);
    }
  }
  if (wanted("tokens") && !pkg.isDatum) {
    const result = checkBindingTokens(pkg);
    if (!result.applicable) record("tokens", 0, "no tokens.json");
    else {
      for (const problem of result.problems) log(`  FAIL ${problem}`);
      record("tokens", result.problems.length === 0 ? 0 : 1, `${result.contract?.tokens?.length ?? 0} token(s)`);
    }
  }

  if (wanted("equality") && pkg.isDatum) {
    const result = await runEquality(pkg, { log });
    record("equality", result.exit, result.skipped);
  }
  const equalityHere = wanted("equality") && !pkg.isDatum;
  let session;
  if (equalityHere || wanted("behaviour") || wanted("binding")) {
    try {
      session = await openSession(pkg, { browserName: options.browser, port: options.port });
    } catch (error) {
      const code = error instanceof PreflightError ? 3 : 4;
      log(`  ${error?.message ?? error}`);
      if (equalityHere) record("equality", code, "no session");
      if (wanted("behaviour")) record("behaviour", code, "no session");
      if (wanted("binding")) record("binding", code, "no session");
    }
  }
  if (session) {
    try {
      if (wanted("binding") && !pkg.isDatum) {
        const problems = [...(await session.lint()), ...session.takeOffline().problems];
        for (const problem of problems) log(`  FAIL ${problem}`);
        record("binding", problems.length === 0 ? 0 : 1, "the binding object");
      }
      if (equalityHere) {
        const result = await runEquality(pkg, { session, update: options.update, report: options.report, only: undefined, log });
        record("equality", result.exit, result.skipped ?? `${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.skip} skip${result.summary.known ? `, ${result.summary.known} known` : ""}`);
      }
      if (wanted("behaviour")) {
        try {
          const result = await runBehaviour(pkg, { session, report: options.report, log });
          record("behaviour", result.exit, `${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.skip} skip${result.summary.known ? `, ${result.summary.known} known` : ""}`);
        } catch (error) {
          if (!(error instanceof PreflightError)) throw error;
          log(`  ${error.message}`);
          record("behaviour", 3, "the known list is invalid");
        }
      }
    } finally {
      await session.close();
    }
  }
  // The package's own checks: what the corpus does not assert for its design system (a binding's extras, notices, scripts).
  if (wanted("checks") && !pkg.isDatum) {
    const scripts = pkg.config?.checks ?? [];
    // A package's scripts launch the browser they need themselves (Chromium: its page.pdf, its own pictures) and take only
    // --port. Under another browser they would run in Chromium all the same, or fail where only that browser is installed.
    if (options.browser && options.browser !== "chromium") record("checks", 0, `not run in ${options.browser}: the package's own checks run in Chromium (kit:check with no --browser)`);
    else if (!Array.isArray(scripts) || scripts.some((script) => typeof script !== "string" || script.trim() === "")) record("checks", 1, "datumBinding.checks must be a list of script paths");
    else if (scripts.length === 0) record("checks", 0, "the package declares no checks of its own (datumBinding.checks)");
    else {
      let exit = 0;
      for (const script of scripts) {
        const file = join(pkg.dir, script);
        const code = existsSync(file) ? await runScript(file, ["--port", String(await pickPort(options.port))], pkg.dir, log) : (log(`  FAIL ${script}: no such file`), 1);
        const mapped = code === 0 ? 0 : code === 1 ? 1 : 4;
        log(`  ${script}: ${mapped === 0 ? "ok" : `exit ${code}`}`);
        if (RANK[mapped] > RANK[exit]) exit = mapped;
      }
      record("checks", exit, `${scripts.length} script(s)`);
    }
  }
  if (wanted("conformance")) {
    try {
      const reportDir = options.report ? join(options.report, "conformance") : undefined;
      if (reportDir) mkdirSync(reportDir, { recursive: true });
      const target = conformanceTarget(pkg);
      const exit = await runConformance({ ...target, ...(reportDir ? { report: reportDir } : {}), ...(options.browser ? { browser: options.browser } : {}), ...(options.port ? { port: await pickPort(options.port) } : {}), log });
      record("conformance", exit, "datum-binding-check");
    } catch (error) {
      log(`  ${error?.message ?? error}`);
      record("conformance", 4, "datum-binding-check could not run");
    }
  }

  const worst = steps.reduce((acc, s) => (RANK[s.exit] > RANK[acc] ? s.exit : acc), 0);
  log(`kit:check ${pkg.id}: ${steps.map((s) => `${s.step} ${s.exit === 0 ? "ok" : `exit ${s.exit}`}`).join(", ")}`);
  return { exit: worst, steps };
}

export async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    const list = () => next().split(",").map((s) => s.trim()).filter(Boolean);
    try {
      if (arg === "--binding") args.binding = next();
      else if (arg === "--skip") args.skip = list();
      else if (arg === "--only") args.only = list();
      else if (arg === "--update-baseline") args.update = true;
      else if (arg === "--report") args.report = resolve(next());
      else if (arg === "--browser") args.browser = next();
      else if (arg === "--port") args.port = Number(next());
      else if (arg === "--help" || arg === "-h") args.help = true;
      else throw new Error(`unknown option ${arg}`);
    } catch (error) {
      console.error(`${error.message}\n${USAGE}`);
      return 2;
    }
  }
  if (args.help || !args.binding) { console.log(USAGE); return args.help ? 0 : 2; }
  for (const step of [...(args.skip ?? []), ...(args.only ?? [])]) {
    if (!STEPS.includes(step)) { console.error(`unknown step "${step}" (${STEPS.join(", ")})`); return 2; }
  }
  let pkg;
  try { pkg = resolveBinding(args.binding); } catch (error) { console.error(error.message); return 2; }
  return (await runCheck(pkg, args)).exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`kit:check: ${error?.stack ?? error}`); process.exitCode = 4; }
  );
}
