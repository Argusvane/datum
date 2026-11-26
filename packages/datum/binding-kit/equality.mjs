#!/usr/bin/env node
// Equality: does the binding draw what the design system draws?
//
//   node binding-kit/equality.mjs --binding govuk [--only a,b] [--update-baseline] [--report dir]
//
// Tier 1, for every bindings/<id>/reference/<case>.html (reference.mjs describes the file): the
// reference markup is drawn three ways on the pinned release,
//   plain    in the document, the design system's files loaded as its own page loads them
//   shadow   in a shadow root, the files adopted by the renderer's adoptInto
//   binding  the form the case describes, drawn by the binding through the renderer
// and the shadow and binding pictures are compared three ways: pixels, every element's box, font
// and colour (paired in document order), and the composed-tree text lines ([visual] / [sr] /
// [live] marks). Shadow against binding is what the case gates on (a loss the binding causes);
// plain against shadow is reported beside it as the cost of the shadow root, never the binding's.
// Pixels gate in Chromium only (sub-pixel font noise elsewhere); boxes and text gate everywhere.
//
// Tier 2, for every tests/tier2/<case>.json (a type the design system has no markup for): the
// binding's picture against its own accepted baseline (baseline.mjs). A first baseline is written
// only with --update-baseline and passes only after a person records a sign-off.
//
// Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PreflightError } from "@argusvane/datum-conformance-suite/binding-check";
import { baselineDir, baselineStatus, readManifest, writeCandidates } from "./lib/baseline.mjs";
import { compareBoxes, compareTexts, describeMismatch } from "./lib/compare.mjs";
import { definitionOf, loadReferences, loadTier2 } from "./lib/reference.mjs";
import { openSession } from "./lib/session.mjs";
import { resolveBinding } from "./lib/binding-package.mjs";

export const USAGE = `equality: holds a binding's drawing to the design system's own markup

Usage
  node binding-kit/equality.mjs --binding <id> [options]

  --binding           bindings/<id> (the reference/ cases and tests/tier2/ cases it holds)
  --only              case ids, comma separated
  --update-baseline   write candidate tier-2 baselines (never a sign-off); without it a baseline is only read
  --report <dir>      report.json and a picture per failing case
  --browser           chromium (default), firefox or webkit
  --port              first port to try (default: the first free one of 5200-5219)
  --list              list the cases
Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.`;

const DEFAULT_PIXELS = 0.0005;
const DEFAULT_BOX = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Doing things to the drawn binding ─────────────────────────────────────────────────────

async function clickExpr(page, expr, what) {
  const rect = await page.evaluate(`(() => { const el = (${expr}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!rect || rect.w === 0 || rect.h === 0) throw new Error(`step click: ${what} not found or has no size`);
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(80);
}

/** Runs a case's `steps` on the page the binding is drawn on (window.bc). */
export async function applySteps(page, steps = []) {
  for (const step of steps) {
    const q = JSON.stringify;
    switch (step.op) {
      case "validate":
        await page.evaluate("bc.validate()");
        break;
      case "focus":
        if (!(await page.evaluate(`bc.focusControl(${q(step.id)}, ${step.index ?? 0}, ${step.which ?? 0})`))) throw new Error(`step focus: no control to focus for "${step.id}"`);
        break;
      case "type": {
        if (!(await page.evaluate(`bc.focusControl(${q(step.id)}, ${step.index ?? 0}, ${step.which ?? 0})`))) throw new Error(`step type: no control to focus for "${step.id}"`);
        for (const ch of step.text) { await page.keyboard.insertText(ch); await sleep(step.gap ?? 20); }
        if (step.commit !== false) { await page.evaluate("bc.blur()"); await page.evaluate("bc.settle(150)"); }
        break;
      }
      case "set":
        await page.evaluate(`bc.setValue(${q(step.path)}, ${q(step.value)})`);
        await page.evaluate("bc.settle(150)");
        break;
      case "click":
        await clickExpr(page, step.value !== undefined ? `bc.optionControl(${q(step.id)}, ${q(step.value)})` : `bc.deepAll(${q(step.selector)}, ${step.id ? q(step.id) : "undefined"})[0]`, step.selector ?? `${step.id}=${step.value}`);
        await page.evaluate("bc.settle(150)");
        break;
      case "press":
        await page.keyboard.press(step.key);
        await sleep(60);
        break;
      case "blur":
        await page.evaluate("bc.blur()");
        break;
      case "settle":
        await page.evaluate(`bc.settle(${step.ms ?? 150})`);
        break;
      case "wait":
        await sleep(step.ms ?? 100);
        break;
      default:
        throw new Error(`unknown step op "${step.op}" (validate, focus, type, set, click, press, blur, settle, wait)`);
    }
  }
}

// ── Drawing and reading one pane ──────────────────────────────────────────────────────────

async function readPane(page, { keepFocus }) {
  if (!keepFocus) await page.evaluate("kit.blur()");
  await sleep(80);
  const [boxes, texts, structure, clip] = await Promise.all([page.evaluate("kit.measure()"), page.evaluate("kit.texts()"), page.evaluate("kit.structure()"), page.evaluate("kit.clip()")]);
  const png = await page.screenshot({ type: "png", fullPage: true, clip, animations: "disabled", caret: "hide" });
  return { boxes, texts, structure, png, size: { width: clip.width, height: clip.height } };
}

async function drawReference(session, kind, entry) {
  const meta = entry.meta;
  const opened = await session.newPage({ lang: meta.lang, bodyClass: meta.bodyClass });
  const payload = {
    html: entry.html,
    assets: session.assets,
    bodyClass: meta.bodyClass ?? session.pkg.assets.bodyClass,
    lang: meta.lang ?? session.pkg.assets.lang,
    width: meta.width ?? 560,
    root: meta.root,
    init: kind === "plain" ? meta.init : meta.initShadow,
    focus: meta.focus,
    ...(kind === "shadow" ? { bindingId: `${session.pkg.id}-reference`, rootFontSize: opened.info.rootFontSize } : {})
  };
  try {
    await opened.page.evaluate(`kit.${kind}(${JSON.stringify(payload)})`);
    const pane = await readPane(opened.page, { keepFocus: !!meta.focus || !!meta.keepFocus });
    return { ...pane, console: opened.console.slice() };
  } finally {
    await opened.close();
  }
}

async function drawBinding(session, entry, id, binding) {
  const meta = entry.meta;
  const definition = definitionOf(meta, id);
  const opened = binding ?? (await session.newPage({ bc: true, lang: meta.lang, bodyClass: meta.bodyClass }));
  const width = meta.width ?? 560;
  const payload = { definition, preset: meta.preset, mode: meta.mode, locale: meta.locale, assets: session.assets };
  const mounted = await opened.page.evaluate(`bc.mount(${JSON.stringify(payload)})`).catch((error) => { throw new Error(`mounting the binding failed: ${String(error.message).split("\n")[0]}`); });
  await opened.page.evaluate(`document.querySelector("[data-bc-host]").style.width = "${width}px"`);
  await applySteps(opened.page, meta.steps);
  await opened.page.evaluate("kit.useDatumRoot()");
  const pane = await readPane(opened.page, { keepFocus: !!meta.keepFocus || (meta.steps ?? []).some((s) => s.op === "focus") });
  const unsupported = await opened.page.evaluate("bc.unsupported()").catch(() => []);
  const dsConsole = await opened.page.evaluate("bc.consoleTake()").catch(() => []);
  return { ...pane, console: [...opened.console, ...dsConsole.map((l) => `${l.type}: ${l.text}`)], unsupported, failed: mounted?.failed ?? null, close: opened.close, opened };
}

// ── Cases ─────────────────────────────────────────────────────────────────────────────────

async function runTier1(session, entry, update, keep) {
  const id = entry.id;
  const meta = entry.meta;
  const tolerance = { pixels: meta.tolerance?.pixels ?? DEFAULT_PIXELS, box: meta.tolerance?.box ?? DEFAULT_BOX };
  if (entry.problems.length > 0) return { id, tier: 1, status: "fail", reasons: entry.problems };
  if (meta.skip) return { id, tier: 1, status: "skip", reasons: [String(meta.skip)] };
  const plain = await drawReference(session, "plain", entry);
  const shadow = await drawReference(session, "shadow", entry);
  const drawn = await drawBinding(session, entry, id);
  try {
    const page = drawn.opened.page;
    const pixelsOf = async (a, b) => {
      const d = await page.evaluate(`kit.diffPng(${JSON.stringify(a.png.toString("base64"))}, ${JSON.stringify(b.png.toString("base64"))})`);
      return d;
    };
    // The binding is held to the reference in a shadow root, unless the case says the design system's script
    // changes what is drawn and the result cannot be had inside a shadow root ("compareWith": "plain").
    const against = meta.compareWith === "plain" ? plain : shadow;
    const diff = await pixelsOf(against, drawn);
    const transfer = await pixelsOf(plain, shadow);
    const boxes = compareBoxes(against.boxes, drawn.boxes, tolerance.box, meta.ignoreBoxes);
    const text = compareTexts(against.texts, drawn.texts, meta.ignoreText);
    const transferBoxes = compareBoxes(plain.boxes, shadow.boxes, tolerance.box, meta.ignoreBoxes);
    const transferText = compareTexts(plain.texts, shadow.texts, meta.ignoreText);
    const reasons = [];
    const gatePixels = session.browserName === "chromium";
    const pixelsOk = diff.fraction <= tolerance.pixels;
    if (!pixelsOk && gatePixels) reasons.push(`pixels: ${diff.differing} of ${diff.total} differ (${(diff.fraction * 100).toFixed(3)}%, allowed ${(tolerance.pixels * 100).toFixed(3)}%)`);
    if (boxes.mismatches.length > 0) reasons.push(`boxes: ${boxes.mismatches.length} of ${Math.max(boxes.count.reference, boxes.count.binding)} elements differ; first: ${describeMismatch(boxes.mismatches[0])}`);
    if (!text.equal) reasons.push(`text: ${text.differences.length} line(s) differ; first: ${text.differences[0].side}: ${text.differences[0].line}`);
    if (drawn.failed) reasons.push(`the binding could not be drawn: ${drawn.failed}`);
    // A known difference (a documented, accepted gap between the binding and the design system) is reported, not failed;
    // when the case starts to pass, the marker is stale and the case fails until it is removed.
    const known = typeof meta.known === "string" ? meta.known : undefined;
    const failed = known ? reasons.length === 0 : reasons.length > 0;
    if (known && reasons.length === 0) reasons.push(`known difference no longer differs: remove "known" from the case (${known})`);
    const result = {
      id,
      tier: 1,
      status: failed ? "fail" : known ? "known" : "pass",
      known,
      reasons,
      pixels: { differing: diff.differing, total: diff.total, fraction: diff.fraction, allowed: tolerance.pixels, gated: gatePixels, ok: pixelsOk },
      boxes: { count: boxes.count, mismatches: boxes.mismatches.slice(0, 12) },
      text: { lines: text.lines, differences: text.differences.slice(0, 20) },
      shadowTransfer: { pixelsFraction: transfer.fraction, boxMismatches: transferBoxes.mismatches.length, textDifferences: transferText.differences.length, firstBox: transferBoxes.mismatches[0] ? describeMismatch(transferBoxes.mismatches[0]) : undefined, firstText: transferText.differences[0] },
      unsupported: drawn.unsupported,
      console: [...new Set([...plain.console, ...shadow.console, ...drawn.console])].slice(0, 10),
      pictures: failed || keep ? { reference: against.png, binding: drawn.png, diff: Buffer.from(diff.diff, "base64"), plain: plain.png } : undefined
    };
    return result;
  } finally {
    await drawn.close();
  }
}

async function runTier2(session, entry, { update, pending }) {
  const id = entry.id;
  const meta = entry.meta;
  const pkg = session.pkg;
  const dir = baselineDir(pkg);
  const tolerance = meta.tolerance?.pixels ?? DEFAULT_PIXELS;
  if (entry.problems.length > 0) return { id, tier: 2, status: "fail", reasons: entry.problems };
  if (meta.skip) return { id, tier: 2, status: "skip", reasons: [String(meta.skip)] };
  const drawn = await drawBinding(session, { meta }, id);
  try {
    const page = drawn.opened.page;
    if (drawn.failed) return { id, tier: 2, status: "fail", reasons: [`the binding could not be drawn: ${drawn.failed}`] };
    const file = join(dir, `${id}.png`);
    let diff;
    if (existsSync(file)) diff = await page.evaluate(`kit.diffPng(${JSON.stringify(readFileSync(file).toString("base64"))}, ${JSON.stringify(drawn.png.toString("base64"))})`);
    if (update && (!diff || diff.fraction > tolerance)) {
      pending[id] = drawn.png;
    }
    return { id, tier: 2, status: "pending-status", tolerance, diff, drawn, picture: drawn.png };
  } finally {
    await drawn.close();
  }
}

/** Gives a tier-2 case its final status once the candidates (if any) are written. */
function judgeTier2(pkg, result, manifest, environmentMismatch) {
  if (result.status !== "pending-status") return result;
  const { id, diff, tolerance } = result;
  const status = baselineStatus(baselineDir(pkg), id, manifest);
  const base = { id, tier: 2, console: result.drawn.console.slice(0, 10), unsupported: result.drawn.unsupported };
  if (status.state !== "signed") return { ...base, status: "fail", reasons: [status.reason], pictures: { binding: result.picture } };
  if (environmentMismatch) return { ...base, status: "skip", reasons: [environmentMismatch] };
  if (!diff) return { ...base, status: "fail", reasons: [`baseline ${id}.png cannot be read`] };
  const ok = diff.fraction <= tolerance;
  return {
    ...base,
    status: ok ? "pass" : "fail",
    reasons: ok ? [] : [`pixels: ${diff.differing} of ${diff.total} differ from the signed baseline (${(diff.fraction * 100).toFixed(3)}%, allowed ${(tolerance * 100).toFixed(3)}%); after a deliberate change run with --update-baseline and sign the new PNG off`],
    pixels: { differing: diff.differing, total: diff.total, fraction: diff.fraction, allowed: tolerance },
    pictures: ok ? undefined : { baseline: readFileSync(join(baselineDir(pkg), `${id}.png`)), binding: result.picture, diff: Buffer.from(diff.diff, "base64") }
  };
}

// ── The run ───────────────────────────────────────────────────────────────────────────────

/**
 * Runs the equality cases of a binding. Resolves to `{ exit, cases, summary, candidates }`.
 * `options`: { only, update, report, browserName, port, keep, log, session }.
 */
export async function runEquality(binding, options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const pkg = typeof binding === "string" ? resolveBinding(binding) : binding;
  if (pkg.isDatum) {
    log("equality datum: skipped. Datum is the reference, not a design system: it has no markup to compare with; its pictures are guarded by the visual baseline (npm run visual).");
    return { exit: 0, cases: [], summary: { pass: 0, fail: 0, skip: 0 }, skipped: "datum has no external reference" };
  }
  const wanted = (id) => !options.only?.length || options.only.includes(id);
  const references = loadReferences(pkg).filter((entry) => wanted(entry.id));
  const tier2 = loadTier2(pkg).filter((entry) => wanted(entry.id));
  if (references.length === 0 && tier2.length === 0) {
    log(`equality ${pkg.id}: nothing to assert: ${pkg.referenceDir}/*.html and ${pkg.testsDir}/tier2/*.json hold no case${options.only?.length ? ` matching ${options.only.join(",")}` : ""}.`);
    return { exit: 2, cases: [], summary: { pass: 0, fail: 0, skip: 0 } };
  }
  const own = !options.session;
  const session = options.session ?? (await openSession(pkg, { browserName: options.browserName, port: options.port }));
  const results = [];
  const candidates = {};
  try {
    log(`equality ${pkg.id} on ${session.browser.version}${session.browserName === "chromium" ? "" : " (pixels reported, not gated)"}: ${references.length} reference case(s), ${tier2.length} tier-2 case(s)`);
    for (const entry of references) {
      let result;
      try {
        result = await runTier1(session, entry, options.update, options.keep);
      } catch (error) {
        result = { id: entry.id, tier: 1, status: "fail", reasons: [`error: ${String(error?.message ?? error).split("\n")[0]}`] };
      }
      results.push(result);
      log(`  ${result.status.toUpperCase().padEnd(4)} ${entry.id}${result.status === "fail" ? `\n         ${result.reasons.join("\n         ")}` : ""}${result.status === "skip" ? ` (${result.reasons[0]})` : ""}${result.status === "known" ? `\n         known: ${result.known}\n         still differs: ${result.reasons[0]}` : ""}`);
    }
    const t2 = [];
    for (const entry of tier2) {
      try {
        t2.push(await runTier2(session, entry, { update: options.update, pending: candidates }));
      } catch (error) {
        t2.push({ id: entry.id, tier: 2, status: "fail", reasons: [`error: ${String(error?.message ?? error).split("\n")[0]}`] });
      }
    }
    let written;
    if (options.update && Object.keys(candidates).length > 0) {
      written = writeCandidates(baselineDir(pkg), candidates, { platform: process.platform, browser: session.browser.version });
      log(`  wrote ${written.written.length} candidate baseline(s) to ${baselineDir(pkg)}: ${written.written.join(", ")}`);
      log(`  the sign-off is yours: look at each PNG, then fill signOff.reviewer and signOff.date in manifest.json (they are blank${written.blanked ? "" : " only where a PNG changed"}).`);
    }
    const manifest = readManifest(baselineDir(pkg));
    // The baseline is a Chromium picture: Firefox and WebKit draw text and form controls their own way, so
    // their runs assert tier 1 (boxes and words) and behaviour, and compare no tier-2 picture.
    const environmentMismatch = session.browserName !== "chromium"
      ? `the baseline is a Chromium picture; ${session.browserName} draws text and controls its own way, so this run does not compare it`
      : manifest.environment?.platform && manifest.environment.platform !== process.platform
        ? `the baseline was recorded on ${manifest.environment.platform} (${manifest.environment.browser ?? "?"}); sub-pixel text differs across platforms, so this ${process.platform} run does not compare it`
        : undefined;
    for (const raw of t2) {
      const result = judgeTier2(pkg, raw, manifest, environmentMismatch);
      results.push(result);
      log(`  ${result.status.toUpperCase().padEnd(4)} tier2/${result.id}${result.status === "fail" ? `\n         ${result.reasons.join("\n         ")}` : ""}${result.status === "skip" ? ` (${result.reasons[0]})` : ""}`);
    }
    // Offline: a request nothing answered is a failure of the run, whatever the pictures say.
    const offline = session.takeOffline();
    for (const note of offline.notes) log(`  ${note}`);
    for (const problem of offline.problems) {
      results.push({ id: "offline", tier: 0, status: "fail", reasons: [problem] });
      log(`  FAIL offline\n         ${problem}`);
    }
  } finally {
    if (own) await session.close();
  }
  const summary = { pass: 0, fail: 0, skip: 0, known: 0 };
  for (const r of results) summary[r.status] += 1;
  const asserted = summary.pass + summary.fail;
  const exit = summary.fail > 0 ? 1 : asserted === 0 ? 2 : 0;
  log(`equality ${pkg.id}: ${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skip${summary.known ? `, ${summary.known} known difference(s)` : ""}`);
  if (options.report) writeReport(options.report, pkg, session, results);
  return { exit, cases: results, summary, candidates: Object.keys(candidates) };
}

function writeReport(dir, pkg, session, results) {
  mkdirSync(dir, { recursive: true });
  const slim = results.map(({ pictures, picture, drawn, diff, ...rest }) => rest);
  writeFileSync(join(dir, "equality.json"), JSON.stringify({ tool: "binding-kit equality", binding: pkg.id, release: pkg.config?.release, browser: session.browser.version, at: new Date().toISOString(), cases: slim }, null, 2));
  for (const r of results) {
    for (const [name, bytes] of Object.entries(r.pictures ?? {})) writeFileSync(join(dir, `${r.id}-${name}.png`), bytes);
  }
}

// ── Command line ──────────────────────────────────────────────────────────────────────────

export async function main(argv) {
  const args = { only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === "--binding") args.binding = next();
    else if (arg === "--only") args.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--update-baseline") args.update = true;
    else if (arg === "--report") args.report = resolve(next());
    else if (arg === "--browser") args.browserName = next();
    else if (arg === "--port") args.port = Number(next());
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else { console.error(`unknown option ${arg}\n${USAGE}`); return 2; }
  }
  if (args.help || !args.binding) { console.log(USAGE); return args.help ? 0 : 2; }
  let pkg;
  try { pkg = resolveBinding(args.binding); } catch (error) { console.error(error.message); return 2; }
  if (args.list) {
    for (const r of loadReferences(pkg)) console.log(`${r.id}  (${r.meta.source ?? "no source"})`);
    for (const r of loadTier2(pkg)) console.log(`tier2/${r.id}`);
    return 0;
  }
  try {
    return (await runEquality(pkg, args)).exit;
  } catch (error) {
    if (error instanceof PreflightError) { console.error(error.message); return 3; }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`equality: ${error?.stack ?? error}`); process.exitCode = 4; }
  );
}
