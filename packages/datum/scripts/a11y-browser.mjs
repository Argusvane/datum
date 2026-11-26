// The browser accessibility audit: headless Chromium, driven through Playwright
// (scripts/playwright-driver.mjs), loads a11y/audit.html over the demo server and runs axe-core —
// colour contrast on, which only a browser that lays out and paints can judge — for every
// variant of the Datum form (its binding under the light and the dark colour scheme) in every
// audit state. Writes the result as the committed baseline (a11y/baseline/browser.json), or with
// --check compares against it and exits 1 on drift. Needs `npm run build` first (the page
// loads dist/datum-form.js) and Playwright's Chromium (`npx playwright install chromium`).
//
//   npm run a11y:browser                  write the baseline and re-render the tracking document
//   npm run a11y:browser -- --check       compare with the baseline (CI)
//   npm run a11y:browser -- --variant datum-dark --json out.json
//
// $CHROME names another Chrome or Chromium binary to use instead of Playwright's. The server
// takes $PORT (4174 by default, clear of the demo's 4173).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { packageReport } from "./a11y-report.mjs";
import { diff, launch, packageRoot as root, sortKeys, waitFor } from "./playwright-driver.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
const check = flag("--check");
const onlyVariants = values("--variant");
const jsonOut = values("--json")[0];
const baselinePath = join(root, "a11y", "baseline", "browser.json");

if (!existsSync(join(root, "dist", "datum-form.js"))) {
  console.error("a11y-browser: dist/datum-form.js is missing — run `npm run build` first");
  process.exit(2);
}
if (!existsSync(join(root, "node_modules", "axe-core", "axe.min.js"))) {
  console.error("a11y-browser: node_modules/axe-core is missing — run `npm install`");
  process.exit(2);
}

/**
 * What the baseline gates: per variant, per state, the axe version, the violations and the rules
 * passed. The `incomplete` list ("needs manual review": a contrast axe could not compute through a
 * pseudo element or a background image) depends on the platform's Chrome — the baseline is
 * recorded on macOS, CI runs Linux — so it is compared separately and only warned about.
 */
function comparable(baseline) {
  const results = Object.fromEntries(Object.entries(baseline.results).map(([variant, states]) => [
    variant,
    Object.fromEntries(Object.entries(states).map(([state, result]) => [state, { ...result, incomplete: undefined }]))
  ]));
  return sortKeys({ axeVersion: baseline.axeVersion, results });
}

/** The advisory part of the baseline: the `incomplete` lists alone. */
function advisory(baseline) {
  const results = Object.fromEntries(Object.entries(baseline.results).map(([variant, states]) => [
    variant,
    Object.fromEntries(Object.entries(states).map(([state, result]) => [state, { incomplete: result.incomplete }]))
  ]));
  return sortKeys({ results });
}

let exitCode = 0;
let chrome;
try {
  chrome = await launch({ serverPort: Number(process.env.PORT ?? 4174), who: "a11y-browser", readyPath: "/a11y/audit.html" });
} catch (error) {
  console.error(`a11y-browser: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
try {
  const page = await chrome.open("/a11y/audit.html");
  await waitFor(() => page.evaluate("!!window.__ready"), { what: "the audit page (see console for errors)", every: 200, who: "a11y-browser" });

  const variants = (await page.evaluate("window.__variants()"))
    .map((entry) => entry.id)
    .filter((id) => onlyVariants.length === 0 || onlyVariants.includes(id));
  const states = await page.evaluate("window.__states()");
  const results = {};
  let axeVersion;
  let failures = 0;
  for (const variant of variants) {
    results[variant] = {};
    for (const state of states) {
      const result = await page.evaluate(`window.__audit(${JSON.stringify(variant)}, ${JSON.stringify(state.id)})`);
      axeVersion = result.axeVersion;
      delete result.axeVersion;
      results[variant][state.id] = result;
      failures += result.violations.length;
      const contrast = result.violations.filter((entry) => entry.ruleId === "color-contrast").length;
      console.log(`${variant.padEnd(24)} ${state.id.padEnd(12)} ${String(result.violations.length).padStart(3)} violations (${contrast} colour-contrast), ${result.incomplete.length} incomplete, ${result.passes.length} rules passed`);
    }
  }
  if (page.console.length > 0) {
    console.log("\npage console:\n" + page.console.map((line) => `  ${line}`).join("\n"));
  }

  const baseline = {
    chrome: chrome.version,
    axeVersion,
    states: states.map((state) => state.id),
    variants,
    results
  };
  if (jsonOut) {
    writeFileSync(jsonOut, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\na11y-browser: wrote ${jsonOut}`);
  }
  if (check) {
    if (!existsSync(baselinePath)) {
      console.error(`\na11y-browser: no baseline at ${baselinePath} — run \`npm run a11y:browser\` to write it`);
      exitCode = 1;
    } else {
      const committed = JSON.parse(readFileSync(baselinePath, "utf8"));
      const scoped = onlyVariants.length === 0 ? committed : { ...committed, results: Object.fromEntries(variants.map((id) => [id, committed.results[id]])) };
      const lines = diff(comparable(scoped), comparable(baseline));
      const advisoryLines = diff(advisory(scoped), advisory(baseline));
      if (advisoryLines.length > 0) {
        console.warn(`\na11y-browser: the "incomplete" lists differ from a11y/baseline/browser.json (manual-review items vary by platform; not a failure — \`npm run a11y:browser\` on the baseline's platform re-records them):\n${advisoryLines.join("\n")}`);
      }
      if (lines.length === 0) {
        console.log(`\na11y-browser: ${variants.length} variants × ${states.length} states match a11y/baseline/browser.json (${failures} recorded violations)`);
      } else {
        console.error(`\na11y-browser: drift from a11y/baseline/browser.json — look, then \`npm run a11y:browser\` to accept:\n${lines.join("\n")}`);
        exitCode = 1;
      }
    }
  } else if (onlyVariants.length === 0) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    const report = packageReport();
    mkdirSync(dirname(report.path), { recursive: true });
    writeFileSync(report.path, report.document);
    console.log(`\na11y-browser: ${variants.length} variants × ${states.length} states → a11y/baseline/browser.json (${failures} violations recorded); ${report.path} re-rendered`);
  } else {
    console.log("\na11y-browser: a --variant run never rewrites the baseline; use --json to keep it");
  }
} catch (error) {
  console.error(`\na11y-browser: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await chrome.close();
}
process.exit(exitCode);
