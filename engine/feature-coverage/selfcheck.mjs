#!/usr/bin/env node
// The harness's own checks: faults injected into a mounted form that the shared assertions, the
// announcement recorder and the reporter must catch. A harness that passes a broken form is worse
// than none, so each check here is a fault the harness once let through.
//
//   node feature-coverage/selfcheck.mjs [--port 4820]
//
// Exit 0 when every fault is caught, 1 when one is not, 4 on an internal error.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

import { buildHost } from "./lib/build.mjs";
import { Scenario } from "./lib/driver.mjs";
import { featureStatuses, runFailed, summarize } from "./lib/report.mjs";
import { PORT_RANGE, serve } from "./lib/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { port: { type: "string", default: String(PORT_RANGE[0]) } } });

const results = [];
/** The host the page checks run in (both hosts catch the same faults); empty for the checks that need no page. */
let currentHost = "";
const expect = (name, ok, detail) => results.push({ name: currentHost ? `[${currentHost}] ${name}` : name, ok: !!ok, ...(ok ? {} : { detail }) });

/** The last shared check of `name` the scenario recorded. */
const lastShared = (t, name) => t.record.shared.at(-1)?.checks.find((c) => c.name === name);
/** Whether any shared check of `name` recorded since index `from` failed. */
const failedSince = (t, name, from) => t.record.shared.slice(from).some((s) => s.checks.some((c) => c.name === name && !c.ok));

// ── The reporter (no browser) ──────────────────────────────────────────────────────────────

{
  const checklist = [{ id: "AAA-01", title: "covered" }, { id: "AAA-02", title: "no scenario" }, { id: "AAA-03", title: "pending" }];
  const records = [
    { id: "a", features: ["AAA-01"], status: "pass" },
    { id: "c", features: ["AAA-03"], status: "pending", pending: "waits for phase 4" }
  ];
  const features = featureStatuses(checklist, records);
  expect("report: a feature no scenario covers is uncovered, not pending", features.find((f) => f.id === "AAA-02")?.status === "uncovered", features);
  expect("report: a feature whose scenarios are declared pending stays pending", features.find((f) => f.id === "AAA-03")?.status === "pending", features);
  const summary = summarize(records, features);
  expect("report: an uncovered feature fails a full run", runFailed(summary) === true, summary);
  expect("report: a run narrowed by --only reports it without failing", runFailed(summary, { partial: true }) === false, summary);
  const covered = featureStatuses(checklist.slice(0, 1), records.slice(0, 1));
  expect("report: a run with every feature covered and passing does not fail", runFailed(summarize(records.slice(0, 1), covered)) === false, covered);
}

// ── The runner's exit when nothing runs (no browser: it stops before the build) ─────────────

{
  const run = (...argv) => spawnSync(process.execPath, [join(here, "run.mjs"), ...argv], { encoding: "utf8" });
  const skipped = run("--host", "live", "--only", "element-binding-id");
  expect("runner: a scenario that runs only in the element, asked of the live host, exits 2 (nothing ran)", skipped.status === 2, { status: skipped.status, stderr: skipped.stderr });
  const none = run("--only", "NO-SUCH-FEATURE");
  expect("runner: --only matching nothing exits 2", none.status === 2, { status: none.status, stderr: none.stderr });
}

// ── The page ───────────────────────────────────────────────────────────────────────────────

const CHECKS = [
  {
    name: "runtime: a binding error raised while a later form mounts is reported",
    async run(t) {
      await t.load("single");
      await t.type({ path: "name" }, "Ada Lovelace");
      await t.key("Tab");
      // Events the first form records, so the second form's list starts shorter than the first's.
      await t.page.evaluate(() => {
        const host = window.fc.hostElement();
        host.dispatchEvent(new CustomEvent("datum-locale-applied", { detail: { locale: "fr" } }));
        host.dispatchEvent(new CustomEvent("datum-form-action", { detail: { action: "x" } }));
      });
      await t.shared("first form");
      await t.page.evaluate(() => {
        const load = window.fc.load;
        window.fc.load = async (options) => {
          const loaded = await load(options);
          window.fc.hostElement().dispatchEvent(new CustomEvent("datum-binding-error", { detail: { hook: "template", message: "injected at mount" } }));
          return loaded;
        };
      });
      const from = t.record.shared.length;
      await t.load("single");
      await t.shared("second form");
      expect(this.name, failedSince(t, "runtime", from), t.record.shared.slice(from));
    }
  },
  {
    name: "runtime: a binding error is reported once, not again at the next check",
    async run(t) {
      await t.load("single");
      await t.page.evaluate(() => window.fc.hostElement().dispatchEvent(new CustomEvent("datum-binding-error", { detail: { hook: "probe", message: "once" } })));
      await t.shared("raised");
      const first = lastShared(t, "runtime");
      await t.shared("again");
      expect(this.name, first?.ok === false && lastShared(t, "runtime")?.ok === true, [first, lastShared(t, "runtime")]);
    }
  },
  ...["aria-controls", "aria-errormessage", "aria-owns", "aria-activedescendant", "aria-describedby", "aria-labelledby"].map((attr) => ({
    name: `references: ${attr} naming a missing id fails`,
    async run(t) {
      await t.load("coverage-tabs");
      await t.page.evaluate((a) => window.fc.hostElement().shadowRoot.querySelector('[role="tab"]').setAttribute(a, "no-such-id"), attr);
      await t.shared("broken reference");
      const references = lastShared(t, "references");
      expect(this.name, references?.ok === false && references.problems.some((p) => p.message.startsWith(`${attr}="no-such-id"`)), references);
    }
  })),
  {
    name: "announcements: the same words written again into a live region are said again",
    async run(t) {
      await t.load("counts");
      await t.announcements();
      const said = await t.page.evaluate(async () => {
        const region = window.fc.hostElement().shadowRoot.querySelector("[data-count-announcer]");
        const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
        region.textContent = "7 characters left";
        await pause();
        // Cleared and set in one task: what a live region reads out again.
        region.textContent = "";
        region.textContent = "7 characters left";
        await pause();
        // Set to the same words with no clear: the text node is replaced, said again.
        region.textContent = "7 characters left";
        await pause();
        // An attribute change alone says nothing.
        region.setAttribute("data-probe", "1");
        await pause();
        return window.fc.announcements().map((a) => a.text);
      });
      expect(this.name, JSON.stringify(said) === JSON.stringify(["7 characters left", "7 characters left", "7 characters left"]), said);
    }
  }
];

let server;
let browser;
try {
  const { files } = await buildHost({});
  server = await serve(files, Number(args.port));
  browser = await chromium.launch();
  for (const host of ["live", "element"]) for (const check of CHECKS) {
    currentHost = host;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Accessibility.enable");
      await page.goto(`${server.url}?host=${host}`);
      await page.waitForFunction(() => window.fc?.ready === true, undefined, { timeout: 10000 });
      const record = { id: "selfcheck", features: [], fixtures: [], checks: [], shared: [], console: [] };
      await check.run.call(check, new Scenario(page, cdp, record));
    } catch (error) {
      expect(check.name, false, `threw: ${String(error?.message ?? error).split("\n")[0]}`);
    } finally {
      await context.close().catch(() => undefined);
    }
  }
} catch (error) {
  console.error(`selfcheck: ${error?.stack ?? error}`);
  await browser?.close().catch(() => undefined);
  await server?.close();
  process.exit(4);
}
await browser?.close().catch(() => undefined);
await server?.close();

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `  ${JSON.stringify(r.detail).slice(0, 400)}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\nselfcheck: ${results.length - failed} caught, ${failed} missed`);
process.exit(failed > 0 ? 1 : 0);
