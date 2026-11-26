#!/usr/bin/env node
// The feature-coverage harness: every Datum feature on the checklist
// (CHECKLIST.md), exercised on the renderer (render/live) with the Datum binding, over forms from
// the engine's test corpus, in headless Chromium through Playwright. It asserts what each feature
// does; it never compares with another renderer.
//
// There are two hosts (host/entry.ts): `live` mounts the renderer directly (mountLive), `element`
// mounts the real <datum-form-renderer> and drives it through its public properties and methods.
// A scenario runs in both unless it names its hosts (`hosts: ["element"]` for the element's own
// settings); each host has its own checklist of the features its scenarios cover. A run passes
// only when every host chosen passes.
//
//   npm run test:features -- [--only VAL-01,summary-links] [--host live|element|both] [--port 4820]
//                            [--report <file>] [--engine-root <copy of form-engine>] [--headed]
//                            [--verbose] [--list]
//
// FEATURES_PORTS=start-end moves the harness's port range (default 4820-4899), so agents sharing a
// machine each keep to their own.
//
// `node feature-coverage/selfcheck.mjs` checks the harness itself: faults the shared assertions,
// the announcement recorder and the reporter must catch.
//
// Exit codes: 0 no failure (pending scenarios are reported, not failed), 1 a scenario failed or
// (on a run not narrowed by --only) a checklist feature has no scenario at all, 2 nothing ran
// (--only matched nothing, or nothing it matched runs in the --host chosen), 4 internal (build,
// server, browser).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

import { buildHost, harnessRoot } from "./lib/build.mjs";
import { Scenario, ScenarioStop } from "./lib/driver.mjs";
import { featureStatuses, printReport, readChecklist, runFailed, scenarioStatus, summarize } from "./lib/report.mjs";
import { PORT_RANGE, serve } from "./lib/server.mjs";
import { SCENARIOS } from "./scenarios/index.mjs";

/** Whether a scenario runs in `host`: both unless it names its hosts (`hosts: ["element"]`). */
const runsIn = (scenario, host) => scenario.hosts === undefined || scenario.hosts.includes(host);

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    port: { type: "string", default: String(PORT_RANGE[0]) },
    host: { type: "string", default: "both" },
    report: { type: "string", default: join(harnessRoot, ".report", "report.json") },
    "engine-root": { type: "string" },
    headed: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    timeout: { type: "string", default: "30000" }
  }
});

const checklist = readChecklist(join(harnessRoot, "CHECKLIST.md"));
const known = new Set(checklist.map((row) => row.id));
for (const scenario of SCENARIOS) {
  for (const id of scenario.features) {
    if (!known.has(id)) {
      console.error(`Scenario ${scenario.id} covers ${id}, which CHECKLIST.md does not list.`);
      process.exit(4);
    }
  }
}

if (args.list) {
  for (const row of checklist) {
    const by = SCENARIOS.filter((s) => s.features.includes(row.id)).map((s) => s.id + (s.pending ? " (pending)" : ""));
    console.log(`${row.id}  ${row.title}${by.length ? `  <- ${by.join(", ")}` : ""}`);
  }
  process.exit(0);
}

if (!["live", "element", "both"].includes(args.host)) {
  console.error(`--host must be live, element or both (got "${args.host}").`);
  process.exit(2);
}
const hosts = args.host === "both" ? ["live", "element"] : [args.host];

const only = args.only ? new Set(args.only.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
const chosen = only ? SCENARIOS.filter((s) => only.has(s.id) || s.features.some((f) => only.has(f))) : SCENARIOS;
if (chosen.length === 0) {
  console.error(`--only ${args.only} matches no scenario.`);
  process.exit(2);
}
if (!hosts.some((host) => chosen.some((scenario) => runsIn(scenario, host)))) {
  console.error(`No scenario chosen runs in the ${hosts.join(" or ")} host: ${chosen.map((s) => `${s.id} runs in ${s.hosts.join(", ")}`).join("; ")}.`);
  process.exit(2);
}

const started = Date.now();
let server;
let browser;
const records = [];
try {
  const engineRoot = args["engine-root"] ? resolve(args["engine-root"]) : undefined;
  const { files, ms } = await buildHost({ engineRoot });
  server = await serve(files, Number(args.port));
  browser = await chromium.launch({ headless: !args.headed });
  if (args.verbose) console.log(`built ${files.size} files in ${ms} ms${engineRoot ? ` from ${engineRoot}` : ""}; ${server.url}; Chromium ${browser.version()}`);

  for (const host of hosts) for (const scenario of chosen) {
    // A scenario about the element's own settings has nothing to say in the live host.
    if (!runsIn(scenario, host)) continue;
    const record = {
      host,
      id: scenario.id,
      title: scenario.title,
      features: scenario.features,
      ...(scenario.pending ? { pending: scenario.pending } : {}),
      fixtures: [],
      checks: [],
      shared: [],
      console: []
    };
    const t0 = Date.now();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // A control that is not there fails its step in 5 s, not at the scenario's timeout.
    page.setDefaultTimeout(5000);
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      await page.goto(`${server.url}?host=${host}`);
      await page.waitForFunction(() => window.fc?.ready === true, undefined, { timeout: 10000 });
      const reported = await page.evaluate(() => window.fc.host);
      if (reported !== host) throw new Error(`the page mounts in the "${reported}" host, not "${host}"`);
      const t = new Scenario(page, cdp, record);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${args.timeout} ms`)), Number(args.timeout));
      });
      try {
        await Promise.race([scenario.run(t), timeout]);
      } catch (error) {
        if (!(error instanceof ScenarioStop)) record.error = String(error?.stack ?? error).split("\n").slice(0, 4).join(" | ");
      } finally {
        clearTimeout(timer);
      }
      if (!record.error) await t.shared("end").catch((error) => (record.error = `shared assertions at the end: ${error?.message ?? error}`));
      record.console = await page.evaluate(() => window.fc.consoleTake()).catch(() => []);
    } catch (error) {
      record.error = String(error?.message ?? error);
    } finally {
      await context.close().catch(() => undefined);
    }
    record.durationMs = Date.now() - t0;
    Object.assign(record, scenarioStatus(record));
    records.push(record);
  }
} catch (error) {
  console.error(`feature-coverage: ${error?.stack ?? error}`);
  await browser?.close().catch(() => undefined);
  await server?.close();
  process.exit(4);
}
await browser?.close().catch(() => undefined);
await server?.close();

const byHost = {};
for (const host of hosts) {
  const hostRecords = records.filter((r) => r.host === host);
  const features = featureStatuses(checklist, hostRecords, SCENARIOS.filter((s) => runsIn(s, host)), SCENARIOS);
  byHost[host] = { summary: summarize(hostRecords, features), scenarios: hostRecords, features };
}
const report = {
  harness: "engine/feature-coverage",
  renderer: "render/live createDatumBinding() + createDatumFeatures(), mounted by mountLive (host live) and by <datum-form-renderer> (host element)",
  browser: "chromium (Playwright)",
  startedAt: new Date(started).toISOString(),
  durationMs: Date.now() - started,
  ...(args["engine-root"] ? { engineRoot: resolve(args["engine-root"]) } : {}),
  ...(only ? { only: [...only] } : {}),
  hosts: byHost
};
try {
  mkdirSync(dirname(resolve(args.report)), { recursive: true });
  writeFileSync(resolve(args.report), JSON.stringify(report, null, 2));
  report.reportPath = resolve(args.report);
} catch (error) {
  console.error(`could not write the report: ${error?.message ?? error}`);
}
let failed = false;
for (const host of hosts) {
  console.log(`\n=== host: ${host} ===`);
  printReport({ ...byHost[host], reportPath: host === hosts.at(-1) ? report.reportPath : undefined }, { verbose: args.verbose });
  failed ||= runFailed(byHost[host].summary, { partial: only !== undefined });
}
process.exit(failed ? 1 : 0);
