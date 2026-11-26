// Visual regression baselines of the Datum form: headless Chromium, driven through
// Playwright (scripts/playwright-driver.mjs), mounts the canonical fixture form on visual/index.html
// in every variant (Datum's binding under the light and the dark colour scheme), in every state, at
// two widths, and captures the form element. Each capture's perceptual signature — size, a
// difference hash, a 24×24 luma grid — is what the committed baseline holds
// (visual/baseline/signatures.json); the PNGs go under visual/out/ for a look (never
// committed; CI keeps them as artefacts). With --check the run compares against the
// baseline and fails on drift: a size that moved, a hash that differs beyond the threshold,
// a cell of the grid whose luma moved further than antialiasing can — the Chrome-only
// regressions that no jsdom test sees. Needs `npm run build` first (the page loads
// dist/datum-form.js) and Playwright's Chromium (`npx playwright install chromium`).
//
//   npm run visual                       write the baseline and the PNGs
//   npm run visual -- --check            compare with the baseline (CI)
//   npm run visual -- --variant datum-dark --out /tmp/shots
//
// A baseline is bound to the platform it was written on: text rasterises differently across
// operating systems and system fonts differ, so a --check on another platform reports drift
// as advisory and exits 0 unless --strict is given. To make the check binding on CI, commit a
// baseline written there (the run uploads one as an artefact). $CHROME names another Chrome or
// Chromium binary to use instead of Playwright's. The server takes $PORT (4175 by default).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { launch, packageRoot as root, waitFor } from "./playwright-driver.mjs";
import { THRESHOLDS, drift } from "./visual-drift.mjs";

export { THRESHOLDS, drift };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
const check = flag("--check");
const strict = flag("--strict");
const onlyVariants = values("--variant");
const outDir = values("--out")[0] ?? join(root, "visual", "out");
const baselinePath = join(root, "visual", "baseline", "signatures.json");

/** The viewport widths a form is captured at: a phone and a desktop column. */
export const WIDTHS = [360, 1024];

if (!existsSync(join(root, "dist", "datum-form.js"))) {
  console.error(`visual-browser: ${join(root, "dist", "datum-form.js")} is missing — run \`npm run build\` first`);
  process.exit(2);
}

let exitCode = 0;
let chrome;
try {
  chrome = await launch({ serverPort: Number(process.env.PORT ?? 4175), who: "visual-browser", readyPath: "/visual/index.html?driver" });
} catch (error) {
  console.error(`visual-browser: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
try {
  const page = await chrome.open("/visual/index.html?driver", { viewport: { width: WIDTHS[1], height: 900 } });
  await waitFor(() => page.evaluate("!!window.__ready"), { what: "the workbench page (see console for errors)", every: 200, who: "visual-browser" });
  const variants = (await page.evaluate("window.__variants()")).filter((entry) => onlyVariants.length === 0 || onlyVariants.includes(entry.id));
  const states = await page.evaluate("window.__states()");

  /** Every (state, locale, frame) a variant is captured in. Text direction follows the locale (the engine writes `dir` on the root), so no capture sets it. */
  const capturesOf = (variant) => [
    ...states.map((state) => ({ id: state.id, state: state.id })),
    { id: "fr-CA", state: "invalid", locale: "fr-CA" },
    ...variant.frames.map((frame) => ({ id: `frame-${frame}`, state: "default", frame }))
  ];

  const results = {};
  let count = 0;
  for (const variant of variants) {
    results[variant.id] = {};
    for (const capture of capturesOf(variant)) {
      for (const width of WIDTHS) {
        await page.pw.setViewportSize({ width, height: 900 });
        const request = { variant: variant.id, state: capture.state, locale: capture.locale ?? "en", frame: capture.frame ?? "" };
        const rect = await page.evaluate(`window.__mount(${JSON.stringify(request)})`);
        await page.evaluate("window.scrollTo(0, 0)");
        const png = await page.pw.screenshot({
          type: "png",
          animations: "disabled",
          fullPage: true,
          clip: { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
        });
        const data = png.toString("base64");
        const signature = await page.evaluate(`window.__signature(${JSON.stringify(data)})`);
        signature.sha256 = createHash("sha256").update(png).digest("hex");
        results[variant.id][`${capture.id}@${width}`] = signature;
        const file = join(outDir, variant.id, `${capture.id}@${width}.png`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, png);
        count += 1;
      }
    }
    console.log(`${variant.id.padEnd(24)} ${Object.keys(results[variant.id]).length} captures`);
  }
  if (page.console.length > 0) {
    console.log("\npage console:\n" + page.console.map((line) => `  ${line}`).join("\n"));
  }

  const baseline = {
    "//": "Perceptual signatures of the canonical fixture form drawn by Datum's binding, per variant × state × width, written on Playwright's Chromium against the live renderer. Written by `npm run visual` in packages/datum; `--check` compares. Bound to the platform below: on another one the check is advisory.",
    platform: process.platform,
    chrome: chrome.version,
    widths: WIDTHS,
    thresholds: THRESHOLDS,
    variants: variants.map((variant) => variant.id),
    results
  };
  const candidatePath = join(outDir, "signatures.json");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(candidatePath, `${JSON.stringify(baseline, null, 2)}\n`);

  if (check) {
    if (!existsSync(baselinePath)) {
      console.error(`\nvisual-browser: no baseline at ${baselinePath} — run \`npm run visual\` to write it`);
      exitCode = 1;
    } else {
      const committed = JSON.parse(readFileSync(baselinePath, "utf8"));
      const samePlatform = committed.platform === process.platform;
      const lines = [];
      for (const variant of variants) {
        const before = committed.results[variant.id] ?? {};
        for (const [key, after] of Object.entries(results[variant.id])) {
          const why = drift(before[key], after);
          if (why) lines.push(`  ${variant.id} ${key}: ${why}`);
        }
        for (const key of Object.keys(before)) {
          if (!(key in results[variant.id])) lines.push(`  ${variant.id} ${key}: no longer captured`);
        }
      }
      if (lines.length === 0) {
        console.log(`\nvisual-browser: ${variants.length} variants, ${count} captures match visual/baseline/signatures.json`);
      } else if (samePlatform || strict) {
        console.error(`\nvisual-browser: drift from visual/baseline/signatures.json — look under ${outDir}, then \`npm run visual\` to accept:\n${lines.join("\n")}`);
        exitCode = 1;
      } else {
        console.log(
          `\nvisual-browser: ${lines.length} differences from a baseline written on ${committed.platform} (this is ${process.platform}) — advisory; commit ${candidatePath} as the baseline to make the check binding here:\n${lines.join("\n")}`
        );
      }
    }
  } else if (onlyVariants.length === 0) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nvisual-browser: ${variants.length} variants, ${count} captures → visual/baseline/signatures.json; PNGs under ${outDir}`);
  } else {
    console.log(`\nvisual-browser: a --variant run never rewrites the baseline; the captures are under ${outDir}`);
  }
} catch (error) {
  console.error(`\nvisual-browser: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await chrome.close();
}
process.exit(exitCode);
