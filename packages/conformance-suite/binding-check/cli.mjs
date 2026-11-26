// datum-binding-check: holds one design-system binding to what Datum asks of it.
// Runs against the engine renderer (engine/form-engine/render/live, mountLive) with a binding module
// that exports createBinding(lit, datum), in headless Chromium through Playwright. Integration only:
// what Datum and the binding write or pass in, never the design system's own quality.
// Exit codes: 0 every case that ran passed, 1 a case failed, 2 usage error or nothing was asserted,
// 3 preflight (Playwright, esbuild or the browser missing; assets; selfCheck), 4 internal error.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, DATUM_BINDING, PreflightError } from "./build.mjs";
import { BROWSERS, Fail, loadPlaywright, openCase, Skip, startBrowser } from "./lib/driver.mjs";
import { CASES, GROUPS } from "./lib/cases.mjs";
import { readRouting } from "./lib/routes.mjs";
import { diffBaseline, summarize, writeReports } from "./lib/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const suiteRoot = resolve(here, "..");

export const USAGE = `datum-binding-check: holds a design-system binding to what Datum asks of it

Usage
  datum-binding-check [--binding <datum | id | module path>] [--assets <assets.json>] [options]

  --binding   datum (the default): Datum's own binding. An id (gcds, govuk, ...): the package bindings/<id> found upward
              from the working directory, with its binding-check.json. A path: a module that exports
              createBinding(lit, datum) (.ts or .js, bundled for the run), with the host's asset list in --assets.
  --assets    The assets file: stylesheets, scripts and fonts as the host lists them, "roots" (folders that stand in for the
              CDN, relative to the file; default: the file's own folder), "binding" (module path, relative to the file),
              "lang", "bodyClass", "designSystem", "print" and "pdf" (the package's print theme and PDF theme modules,
              relative to the file: the PRT and PDF cases), "routes" (a request for a third-party URL answered from the
              design system's pinned stylesheets) and "network" (hosts the run may reach, each with its reason) and
              "known" (cases that fail because of a defect of the design system itself, each with its reason and the date it was declared:
              reported as known while they fail, as a problem once they pass; a case id of another suite, the kit's behaviour suite, is ignored here).
  --only      Case ids or groups, comma separated (MNT,VAL,ERR-01).
  --baseline  A report.json from a known-good release: prints which cases changed state.
  --report    A folder for report.json, junit.xml, report.html and a screenshot per failing case.
  --browser   chromium (the default), firefox or webkit (the corpus is verified on chromium; the others are not yet).
  --port      First port to try (default: any free port).
  --offline   Abort a request to any host the server, a route or "network" does not answer, and fail the run naming it.
  --continue  Run the cases although preflight found a problem.
  --list      List the cases. --case-timeout ms (default 60000).

Needs Playwright and a browser (npx playwright install chromium), and esbuild for any binding but datum: optional
peer dependencies of @argusvane/datum-conformance-suite, used by this command alone.
Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.`;

class Usage extends Error {}

function parse(argv) {
  const out = { only: [], port: 0, caseTimeout: 60000, browser: "chromium" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Usage(`${arg} needs a value`); return argv[++i]; };
    if (arg === "--binding") out.binding = next();
    else if (arg === "--assets") out.assets = next();
    else if (arg === "--only") out.only = next().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === "--baseline") out.baseline = next();
    else if (arg === "--report") out.report = next();
    else if (arg === "--browser") out.browser = next();
    else if (arg === "--port") out.port = Number(next());
    else if (arg === "--case-timeout") out.caseTimeout = Number(next());
    else if (arg === "--continue") out.continue = true;
    else if (arg === "--offline") out.offline = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Usage(`unknown option ${arg}`);
  }
  if (!BROWSERS.includes(out.browser)) throw new Usage(`--browser: one of ${BROWSERS.join(", ")}`);
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65500) throw new Usage("--port needs a port number");
  if (!Number.isFinite(out.caseTimeout) || out.caseTimeout <= 0) throw new Usage("--case-timeout needs a number of milliseconds");
  return out;
}

/** The bindings/<id> folder: found upward from the working directory, then beside the suite in this repository. */
function findBindingDir(id) {
  const starts = [process.cwd(), suiteRoot];
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      const candidate = join(dir, "bindings", id);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

const isPath = (value) => /[\\/]/.test(value) || /\.(m?[jt]s)$/.test(value);

/**
 * What the run is aimed at: `{ name, file, assetsDoc, assetsFile, roots }`. Throws Usage when the arguments do not name a binding.
 * `file` is the binding module, `roots` the folders the server answers asset paths from.
 */
export function resolveTarget(args) {
  const arg = args.binding ?? "datum";
  let assetsFile;
  let name;
  let bindingDir;
  let moduleArg;
  if (arg === "datum") {
    name = "datum";
  } else if (isPath(arg)) {
    moduleArg = resolve(arg);
    name = basename(args.assets ?? arg).replace(/\.[^.]+$/, "");
  } else {
    bindingDir = findBindingDir(arg);
    if (!bindingDir) throw new Usage(`no binding "${arg}": there is no bindings/${arg}/package.json above ${process.cwd()} or beside the suite (give the path of a module to check one elsewhere)`);
    name = arg;
    assetsFile = join(bindingDir, "binding-check.json");
  }
  if (args.assets) assetsFile = resolve(args.assets);
  let assetsDoc = {};
  if (assetsFile) {
    if (!existsSync(assetsFile)) throw new Usage(`assets file not found: ${assetsFile}`);
    try {
      assetsDoc = JSON.parse(readFileSync(assetsFile, "utf8"));
    } catch (error) {
      throw new Usage(`assets file ${assetsFile} is not JSON: ${error.message}`);
    }
  }
  const base = assetsFile ? dirname(assetsFile) : process.cwd();
  let file;
  if (arg === "datum") file = DATUM_BINDING;
  else if (moduleArg) file = moduleArg;
  else if (assetsDoc.binding) file = resolve(base, assetsDoc.binding);
  else file = ["src/binding.ts", "src/index.ts"].map((p) => join(bindingDir, p)).find((p) => existsSync(p));
  if (!file) throw new Usage(`bindings/${arg} has no binding module yet (no "binding" in ${assetsFile}, and no src/binding.ts or src/index.ts)`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Usage(`binding module not found: ${file}`);
  const roots = arg === "datum" ? [] : (assetsDoc.roots ?? ["."]).map((r) => (isAbsolute(r) ? r : resolve(base, r)));
  for (const r of roots) if (!existsSync(r)) throw new Usage(`assets root not found: ${r}`);
  // The package's print theme and PDF theme modules (PRT, PDF), relative to the assets file.
  const modules = {};
  for (const key of ["print", "pdf"]) {
    if (assetsDoc[key] === undefined) continue;
    if (typeof assetsDoc[key] !== "string") throw new Usage(`"${key}" in ${assetsFile} must be the path of a module`);
    const path = resolve(base, assetsDoc[key]);
    if (!existsSync(path)) throw new Usage(`${key} module not found: ${path}`);
    modules[key] = path;
  }
  return { name, file, assetsDoc, assetsFile, roots, modules };
}

/** The host's asset config in the renderer's shape: { url } entries (a string is a url). */
function renderAssets(assetsDoc) {
  const source = (item) => (typeof item === "string" ? { url: item } : item);
  return {
    ...(assetsDoc.stylesheets ? { stylesheets: assetsDoc.stylesheets.map(source) } : {}),
    ...(assetsDoc.fonts ? { fonts: assetsDoc.fonts.map(source) } : {}),
    ...(assetsDoc.scripts ? { scripts: assetsDoc.scripts.map(source) } : {}),
    ...(assetsDoc.rootFontSize ? { rootFontSize: assetsDoc.rootFontSize } : {})
  };
}

function suiteVersion() {
  try {
    return JSON.parse(readFileSync(join(suiteRoot, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Runs the command line; resolves to the exit code. `io` carries the two output streams. */
export async function runBindingCheck(argv, io = { out: (text) => console.log(text), err: (text) => console.error(text) }) {
  const out = io.out;
  const err = io.err;
  let args;
  try { args = parse(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { out(USAGE); return 0; }
  if (args.list) {
    for (const c of CASES) out(`${c.id.padEnd(8)} ${c.pending ? "(pending) " : ""}${c.title}`);
    out("\nGroups:\n" + Object.entries(GROUPS).map(([g, t]) => `  ${g.padEnd(5)} ${t}`).join("\n"));
    return 0;
  }
  let target;
  try { target = resolveTarget(args); } catch (e) { if (e instanceof Usage) { err(`${e.message}\n${USAGE}`); return 2; } throw e; }
  const wanted = (c) => args.only.length === 0 || args.only.some((o) => c.id === o || c.group === o);
  const selected = CASES.filter(wanted);
  if (selected.length === 0) { err(`--only ${args.only.join(",")} selects no case (try --list)`); return 2; }

  // Preflight 1: the tools the run needs are installed (optional peers: Playwright always, esbuild for a
  // binding module to bundle) and the host module is there (the package's dist/host.js).
  let playwright;
  try {
    playwright = await loadPlaywright();
  } catch (e) {
    if (e instanceof PreflightError) { err(e.message); return 3; }
    throw e;
  }

  const { name: bindingName, file, assetsDoc, roots, assetsFile } = target;
  let routing;
  try {
    routing = readRouting(assetsDoc, assetsFile ?? "the assets file");
  } catch (e) {
    if (e instanceof PreflightError) { err(e.message); return 3; }
    throw e;
  }
  const assets = renderAssets(assetsDoc);
  const moduleEntries = Object.fromEntries(Object.entries(target.modules ?? {}).map(([key, path]) => [`${key}-theme`, path]));
  let built;
  try {
    built = await buildRun({ binding: file, name: bindingName, extraEntries: moduleEntries });
  } catch (error) {
    if (error instanceof PreflightError) { err(error.message); return 3; }
    err(`building ${file} failed: ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n")}`);
    return 3;
  }
  const { hostUrl, bindingUrl } = built;
  let browser;
  try {
    browser = await startBrowser({ port: args.port, roots, builds: [built], browserName: args.browser, playwright, ...routing, offline: args.offline === true });
  } catch (error) {
    built.dispose();
    if (error instanceof PreflightError) { err(error.message); return 3; }
    throw error;
  }
  const cleanup = async () => { await browser.close(); built.dispose(); };
  const onSigint = () => { cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", onSigint);
  try {
    const startedAt = new Date().toISOString();
    // Datum's own binding prints under Datum's own print theme (served beside the host module); a package's modules are built with its binding.
    const modules = file === DATUM_BINDING ? { print: built.urlOf("print-theme") } : Object.fromEntries(Object.keys(target.modules ?? {}).map((key) => [key, built.urlOf(`${key}-theme`)]));
    const open = () => openCase(browser, { hostUrl, bindingUrl, assets, pageLang: assetsDoc.lang, bodyClass: assetsDoc.bodyClass, modules });
    // Preflight 2: the assets load, the binding's selfCheck is quiet.
    const preflight = { problems: [] };
    const missing = [];
    for (const url of [...(assets.stylesheets ?? []), ...(assets.fonts ?? []), ...(assets.scripts ?? [])].map((s) => s.url)) {
      // An address a route answers is checked where it is answered (the run draws it); fetching it here would reach the network it replaces.
      if (/^https?:\/\//.test(url) && browser.routing.answers(url)) continue;
      const res = await fetch(new URL(url, `http://127.0.0.1:${browser.server.port}`)).catch(() => undefined);
      if (!res || !res.ok) missing.push(url);
    }
    if (missing.length) preflight.problems.push(`assets not found: ${missing.join(", ")}`);
    let info;
    if (!missing.length) {
      let c;
      try {
        c = await open();
        info = c.info;
        await c.mount("text", { keepConsole: true });
        const events = await c.ev("bc.events()");
        for (const e of events) if (e.type === "datum-binding-error") preflight.problems.push(`${e.detail?.hook}: ${e.detail?.message}`);
        for (const line of await c.takeConsole()) if (line.type === "exception") preflight.problems.push(`exception: ${line.text}`);
      } catch (error) {
        preflight.problems.push(`mount failed: ${String(error.message).split("\n")[0]}`);
      } finally { await c?.page.close(); }
    }
    const binding = { name: bindingName, entry: basename(file), id: info?.id, designSystem: info?.designSystem?.name ?? assetsDoc.designSystem, renderer: "engine render/live", sideEffects: info?.designSystem?.sideEffects ?? [] };
    out(`datum-binding-check  ${bindingName}  (${binding.id ?? "?"}; ${binding.designSystem ?? ""})`);
    // Known defects of the design system, declared in the assets file: a case of this suite that is listed is reported as known while it fails.
    const known = new Map(routing.known.filter((entry) => selected.some((spec) => spec.id === entry.case)).map((entry) => [entry.case, entry]));
    for (const entry of known.values()) out(`KNOWN DEFECT  ${entry.case}: ${entry.reason} (since ${entry.since})`);
    // What the design system changes outside the form's root, as the binding declares it. Reported, never a failure.
    for (const e of binding.sideEffects) out(`SIDE EFFECT  ${e.target}: ${e.effect}`);

    const results = [];
    const shots = {};
    if (preflight.problems.length && !args.continue) {
      for (const p of preflight.problems) out(`PREFLIGHT  ${p}`);
      for (const spec of selected) results.push({ id: spec.id, group: spec.group, title: spec.title, status: spec.pending ? "pending" : "skip", message: spec.pending ?? "preflight failed; cases not run", ms: 0, console: [] });
    } else {
      for (const p of preflight.problems) out(`PREFLIGHT  ${p}  (continuing: --continue)`);
      for (const spec of selected) {
        const t0 = Date.now();
        const result = { id: spec.id, group: spec.group, title: spec.title, status: "pass", message: "", ms: 0, console: [] };
        if (spec.pending) { result.status = "pending"; result.message = spec.pending; }
        else {
          const missingType = (spec.needs ?? []).find((t) => info.types[t] === undefined);
          const capAnswer = spec.cap ? (info.types[spec.cap[0]] ?? []).map((a) => a.capabilities[spec.cap[1]] ?? "none") : undefined;
          if (missingType) { result.status = "skip"; result.message = `the binding declares no adapter for "${missingType}": Datum draws it, so there is nothing of the binding to check`; }
          else if (capAnswer && capAnswer.length && capAnswer.every((a) => a === "none")) { result.status = "skip"; result.message = `the binding answers "none" for ${spec.cap.join(".")}`; }
          else {
            let c;
            let timer;
            try {
              c = await open();
              await Promise.race([spec.run(c), new Promise((_, reject) => { timer = setTimeout(() => reject(new Fail(`timed out after ${args.caseTimeout} ms`)), args.caseTimeout); })]);
            } catch (error) {
              if (error instanceof Skip) { result.status = "skip"; result.message = error.message; }
              else if (error instanceof Fail) { result.status = "fail"; result.message = error.message; }
              else { result.status = "fail"; result.message = `checker error: ${String(error?.message ?? error).split("\n")[0]}`; result.checkerError = true; }
              if (result.status === "fail" && c) { try { shots[spec.id] = await c.shot(); result.shot = `shots/${spec.id}.png`; } catch {} }
            } finally {
              clearTimeout(timer);
              try { await c?.takeConsole(); } catch {}
              result.console = (c?.console ?? []).filter((l) => l.type);
              await c?.page.close().catch(() => undefined);
            }
          }
        }
        result.ms = Date.now() - t0;
        // A listed case: a failure is the design system's, declared and counted apart; a pass means the list is stale.
        const listed = known.get(spec.id);
        if (listed && result.status === "fail" && !result.checkerError) {
          result.status = "known";
          result.known = listed.reason;
          result.message = `known: ${listed.reason}\n          still fails: ${result.message}`;
        } else if (listed && result.status === "pass") {
          result.status = "fail";
          result.message = `listed as known but passes: remove it from "known" in binding-check.json (${listed.reason})`;
        }
        results.push(result);
        out(`${result.status.toUpperCase().padEnd(8)}${spec.id.padEnd(8)}${spec.title}${result.message ? `\n          ${result.message}` : ""}`);
      }
    }

    // The console output of the design system's scripts, across the run.
    const merged = new Map();
    for (const r of results) for (const l of r.console) { const key = `${l.type}|${l.text}`; if (!merged.has(key)) merged.set(key, { type: l.type, text: l.text, cases: [] }); merged.get(key).cases.push(r.id); }
    const report = { tool: "datum-binding-check", version: suiteVersion(), startedAt, browser: browser.version, binding, assets: assetsDoc, preflight, summary: summarize(results), cases: results, console: [...merged.values()] };
    const t = report.summary.total;
    // What the run reached beyond its server: the hosts "network" lists are reported, an unanswered request fails the run.
    for (const note of browser.routing.notes()) out(note);
    const offlineProblems = browser.routing.problems();
    for (const problem of offlineProblems) out(`OFFLINE   ${problem}`);
    report.offline = { problems: offlineProblems, networkNotes: browser.routing.notes() };
    out(`\n${bindingName}: ${t.pass} pass, ${t.fail} fail, ${t.skip} skip, ${t.pending} pending${t.known > 0 ? `, ${t.known} known` : ""}`);
    if (args.report) { writeReports(resolve(args.report), report, shots); out(`report: ${resolve(args.report)}`); }
    if (args.baseline) {
      let previous;
      try { previous = JSON.parse(readFileSync(resolve(args.baseline), "utf8")); } catch (error) { err(`baseline ${args.baseline}: ${error.message}`); return 2; }
      const changes = diffBaseline(previous, report, { partial: args.only.length > 0 });
      out(`\nbaseline ${args.baseline}: ${changes.length} case(s) changed`);
      const groups = new Map();
      for (const ch of changes) { const key = `${ch.from} -> ${ch.to}`; groups.set(key, [...(groups.get(key) ?? []), ch]); }
      for (const [key, list] of groups) {
        const shown = list.length > 12 ? list.slice(0, 3) : list;
        for (const ch of shown) out(`  ${ch.id.padEnd(8)}${key}${ch.to === "fail" ? "  REGRESSION" : ""}${ch.message ? `  (${ch.message})` : ""}`);
        if (list.length > shown.length) out(`  ... and ${list.length - shown.length} more ${key}`);
      }
      report.baselineChanges = changes;
      if (args.report) writeReports(resolve(args.report), report, shots);
    }
    if (preflight.problems.length && !args.continue) return 3;
    if (t.fail > 0 || offlineProblems.length > 0) return 1;
    if (t.pass === 0) { err("nothing was asserted: every selected case was skipped or pending"); return 2; }
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    await cleanup();
  }
}
