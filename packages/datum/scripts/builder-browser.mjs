// The builder's browser harness: headless Chromium, driven
// through Playwright (scripts/playwright-driver.mjs), mounts the builder on
// visual/builder.html in each state at the size tiers of the responsive strategy and
// records four things no jsdom test can see:
//
//   - visual signatures of every capture (the form harness's signature: size, a difference hash,
//     a 24×24 luma grid), PNGs under visual/out/builder/ for a look;
//   - axe violations over the builder, colour contrast on (the WCAG 2.2 A/AA rule set);
//   - the keyboard walk: where each Tab press puts focus, from the page into the builder;
//   - keystroke-to-paint in the inspector on a 50- and a 200-field form: a keystroke into the
//     draft, and a commit (Save) that repaints the canvas;
//   - the Languages workspace on the 200-field form with two more languages: the open
//     until the grid is there, a keystroke into a cell, and a search confirmed with Enter;
//   - the canvas's inertness: a field's leaf template is `inert`
//     in edit mode only, a container's shell never is, every node stays in the accessibility
//     tree with the canvas's tabindex model, and the preview has no `inert` at all. Measured, not
//     baselined: a failure fails the run.
//   - the Print workspace (visual/builder.html): print (a filled sample and a receipt),
//     print-header-footer, print-selected (a component's On paper fields), print-breaks (an
//     estimated page start and an authored break in view), dark-print and
//     phone-print, at the wide and short tiers (phone-print at the phone tiers). New states with no
//     baseline yet: a --check run reports them until a baseline run records them.
//   - the canvas's tags (`--only chips`): a container's type chip clear of the legend or heading a
//     binding drew at its top or its parent's, the hidden tag on its own node's top edge. Measured,
//     not baselined: a failure fails the run.
//
// They are written to visual/builder-baseline/baseline.json, or with --check compared against
// it: a capture that drifts, a new axe violation, a changed Tab order, or a timing more than half
// again slower than the baseline (plus 4 ms) fails the run. A refactor must leave all four
// unchanged; a change that moves them on purpose accepts the move with a fresh baseline.
//
//   npm run builder:browser                  write the baseline and the PNGs
//   npm run builder:browser -- --check       compare with the baseline
//   npm run builder:browser -- --only visual --size wide --state selected
//
// Needs `npm run build` first, and Playwright's Chromium (`npx playwright install chromium`). Like the form harness, a baseline is bound to the platform it was
// written on (fonts and rasterising differ): on another platform the visual and timing checks are
// advisory unless --strict is given; axe and the Tab order are compared everywhere. $CHROME names
// another Chrome or Chromium binary to use instead of Playwright's. The server takes $PORT (4176).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { launch, packageRoot as root, waitFor } from "./playwright-driver.mjs";
import { THRESHOLDS, drift } from "./visual-drift.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));
const check = flag("--check");
const strict = flag("--strict");
const only = new Set(values("--only"));
const onlySizes = values("--size");
const onlyStates = values("--state");
const outDir = values("--out")[0] ?? join(root, "visual", "out", "builder");
const baselinePath = join(root, "visual", "builder-baseline", "baseline.json");
const wants = (part) => only.size === 0 || only.has(part);
const partial = only.size > 0 || onlySizes.length > 0 || onlyStates.length > 0;

/** Every state at the wide and short tiers; the states that decide a layout at the others. */
const FULL_SIZES = new Set(["wide", "short"]);
/** The phone tier's sizes: the core states and the phone's own (phone-*), which exist nowhere else. */
const PHONE_SIZES = new Set(["phone", "phone-small", "phone-box"]);
/** The Tests states run at the phone tiers too: the sheet over the form, and the bar's Stop recording. */
const PHONE_EXTRA_STATES = ["tests-panel", "tests-recording"];
const CORE_STATES = ["canvas", "selected", "panel-components", "panel-outline", "logic", "logic-rule", "data", "data-row", "journeys-overview", "pdf-overview", "journeys-designer", "pdf-designer", "try-it"];
/**
 * The canvas against the browser's own accessibility tree (Chromium's, through a protocol session on the
 * page: Playwright has no call for the tree itself). Every node's grip must be in the tree; no control
 * inside an inert leaf may be (inert takes a subtree out of it); a container's shell must be, a fieldset
 * as its group. Returns the problems, in words.
 */
async function treeProblems(page) {
  const cdp = await page.cdp();
  await cdp.send("DOM.enable");
  const { nodes: dom } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true });
  const { nodes: ax } = await cdp.send("Accessibility.getFullAXTree");
  const byBackend = new Map(ax.filter((node) => node.backendDOMNodeId !== undefined).map((node) => [node.backendDOMNodeId, node]));
  const attributes = (node) => Object.fromEntries((node.attributes ?? []).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value, all[index + 1]]] : pairs), []));
  const classes = (node) => new Set((attributes(node).class ?? "").split(/\s+/));
  const children = new Map();
  for (const node of dom) if (node.parentId !== undefined) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const inTree = (node) => byBackend.has(node.backendNodeId) && !byBackend.get(node.backendNodeId).ignored;
  const nameOf = (node) => attributes(node)["data-component-id"] ?? attributes(node)["data-container-id"] ?? node.nodeName.toLowerCase();
  const problems = [];
  const dbNodes = dom.filter((node) => node.nodeType === 1 && classes(node).has("db-node"));
  for (const node of dbNodes) {
    const kids = children.get(node.nodeId) ?? [];
    const grip = kids.find((kid) => classes(kid).has("db-handle"));
    if (!grip || !inTree(grip)) problems.push(`the node ${nameOf(node)} has no grip in the accessibility tree`);
    if (classes(node).has("db-node--container")) {
      const shell = kids.find((kid) => kid.nodeType === 1 && !classes(kid).has("db-handle") && !classes(kid).has("db-tag"));
      const shown = shell && (inTree(shell) || (children.get(shell.nodeId) ?? []).some(inTree));
      if (!shown) problems.push(`the container ${nameOf(node)} has no shell in the accessibility tree`);
      else if (shell.nodeName === "FIELDSET" && byBackend.get(shell.backendNodeId)?.role?.value !== "group") problems.push(`the container ${nameOf(node)} is a fieldset that is not a group in the tree`);
    }
  }
  const leaves = dom.filter((node) => node.nodeType === 1 && classes(node).has("db-leaf"));
  const controls = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
  const byId = new Map(dom.map((node) => [node.nodeId, node]));
  const below = (node) => (children.get(node.nodeId) ?? []).flatMap((kid) => [kid, ...below(kid)]);
  for (const leaf of leaves) {
    for (const control of below(leaf).filter((node) => controls.has(node.nodeName))) {
      if (inTree(control)) problems.push(`a ${control.nodeName.toLowerCase()} inside the inert leaf of ${nameOf(byId.get(leaf.parentId) ?? leaf)} is in the accessibility tree`);
    }
  }
  return { problems, nodes: dbNodes.length, leaves: leaves.length };
}

/** Tab presses recorded from the page into the builder. */
const TAB_PRESSES = 40;
/**
 * A timing fails when it is this much slower than the baseline's. The baseline's timings are taken on
 * a cool, quiet machine. On this laptop the same tree times about 2.5 times slower once the CPU has
 * been busy for a while (a visual pass, other work on the machine), with no change in the code: the
 * inspector keystroke goes from 1.7 to 4.8 ms, the Languages cell keystroke from 5.8 to about 13 ms.
 * So the timings run first, before the captures (below).
 *
 * A commit (Save) must lay out the builder once: the canvas's bar writes only the readouts that
 * changed (zoom level, Try it, the selection's name) and the drop-zone marking touches only the
 * marks that changed, so a commit costs about 13 ms at 50 and at 200 fields on a hot CPU. The
 * Languages keystroke has no such cost. Typing into one cell lays out the grid, so it grows with the rows, now 339 (see
 * PERF_LANGUAGES). Never raise the slack to pass a hot machine.
 */
const PERF_SLACK = { factor: 1.5, ms: 4 };
const PERF_FORMS = [50, 200];
/**
 * Holds the CPU clock while the timings run. A sample is a few milliseconds of work that follows an
 * idle frame, and a core that has idled drops its clock and takes several milliseconds to climb
 * back, so the same code measures 1.7 ms on a held clock and 5 ms or more on a dropped one: the
 * medians split in two with the machine's state, not the code's. One busy process at the lowest
 * priority keeps a core clocked up and yields to the browser, which still gets its core. It stops
 * with the timings, and on any exit, so nothing is left spinning.
 */
const holdClock = () => {
  const spin = ["-e", "for(;;){}"];
  const child = process.platform === "win32" ? spawn(process.execPath, spin, { stdio: "ignore" }) : spawn("nice", ["-n", "20", process.execPath, ...spin], { stdio: "ignore" });
  child.on("error", () => {});
  const stop = () => {
    child.kill("SIGKILL");
    process.off("exit", stop);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  };
  const interrupted = () => {
    stop();
    process.exit(130);
  };
  process.on("exit", stop);
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  console.log("perf    holding the CPU clock with one idle-priority busy process while timing: an idle core downclocks between samples, which splits short medians in two");
  return stop;
};
/**
 * The Languages grid's timing tier: the 200-field form, two languages beside English. The
 * grid draws its first 200 rows of each group: the form's title and 199 labels, then the form's own
 * words and messages (139 rows), 339 in all. The open is the style and layout of those rows, about
 * half a millisecond each, so it moves with their count, not with the canvas behind it. A cell
 * keystroke lays out the grid too. On a hot machine, in one page, it timed 10.5 to 11 ms at 200 rows
 * and 12.3 to 12.6 ms at 339. On a cool one it times 5.8 to 5.9 ms at 339.
 */
const PERF_LANGUAGES = [{ fields: 200, locales: 2 }];

if (!existsSync(join(root, "dist", "datum-builder.js"))) {
  console.error("builder-browser: dist/datum-builder.js is missing — run `npm run build` first");
  process.exit(2);
}
if (!existsSync(join(root, "node_modules", "axe-core", "axe.min.js"))) {
  console.error("builder-browser: node_modules/axe-core is missing — run `npm install`");
  process.exit(2);
}

let exitCode = 0;
let chrome;
try {
  chrome = await launch({ serverPort: Number(process.env.PORT ?? 4176), who: "builder-browser", readyPath: "/visual/builder.html?driver" });
} catch (error) {
  console.error(`builder-browser: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const result = { visual: {}, axe: {}, keyboard: [], perf: {} };
/** The page of each size tier, opened once: a context of its own, so a phone's `isMobile` is that page's alone. */
const pages = new Map();
try {
  // Captures are taken with motion reduced: a drawer, sheet or snap-back that is still travelling at
  // the shot would move pixels between two runs. The product honours the media query (studio-tokens.ts zeroes
  // the motion tokens; sheet-gestures.ts and phone-styles.ts check it), so this changes no behaviour.
  const pageAt = async (size) => {
    if (!pages.has(size.id)) {
      const page = await chrome.open("/visual/builder.html?driver", {
        viewport: { width: size.width, height: size.height },
        isMobile: size.width < 600,
        reducedMotion: "reduce"
      });
      await waitFor(() => page.evaluate("!!window.__ready"), { what: "the builder workbench (see console for errors)", every: 200, who: "builder-browser" });
      pages.set(size.id, page);
    }
    return pages.get(size.id);
  };
  const probe = await chrome.open("/visual/builder.html?driver", { viewport: { width: 1440, height: 1000 } });
  await waitFor(() => probe.evaluate("!!window.__ready"), { what: "the builder workbench (see console for errors)", every: 200, who: "builder-browser" });
  const sizes = (await probe.evaluate("window.__sizes()")).filter((size) => onlySizes.length === 0 || onlySizes.includes(size.id));
  const states = (await probe.evaluate("window.__states()")).map((state) => state.id).filter((id) => onlyStates.length === 0 || onlyStates.includes(id));
  await probe.close();
  const mount = async (page, state, size) => page.evaluate(`window.__mount(${JSON.stringify({ state, size: size.id })})`);
  const wide = sizes.find((size) => size.id === "wide") ?? sizes[0];

  // The timings first, on a page of their own: after the visual pass the CPU runs slower (see
  // PERF_SLACK), and a full run then timed what `--only perf` does not. Timed first, a full run and
  // `--only perf` time the same way, from a fresh page.
  if (wants("perf") && wide) {
    const page = await pageAt({ ...wide, id: "perf" });
    const releaseClock = holdClock();
    try {
      for (const fields of PERF_FORMS) {
        // One warm-up run, so the first form's compile and font loading are not timed.
        if (fields === PERF_FORMS[0]) await page.evaluate(`window.__perf(${JSON.stringify({ fields, samples: 5 })})`);
        result.perf[fields] = await page.evaluate(`window.__perf(${JSON.stringify({ fields })})`);
        const { keystroke, commit } = result.perf[fields];
        console.log(`perf    ${String(fields).padStart(3)} fields: keystroke median ${keystroke.median} ms (p90 ${keystroke.p90}), commit median ${commit.median} ms (p90 ${commit.p90})`);
      }
      for (const tier of PERF_LANGUAGES) {
        const key = `languages-${tier.fields}`;
        result.perf[key] = await page.evaluate(`window.__perfLanguages(${JSON.stringify(tier)})`);
        const { rows, firstOpen, open, keystroke, search } = result.perf[key];
        console.log(`perf    ${key} (${rows} rows): first open ${firstOpen.median} ms, open median ${open.median} ms (p90 ${open.p90}), cell keystroke median ${keystroke.median} ms (p90 ${keystroke.p90}), search median ${search.median} ms (p90 ${search.p90})`);
      }
    } finally {
      releaseClock();
    }
    // Its console stays readable below; the page itself goes, so nothing of it runs beside the captures.
    await page.close();
  }

  if (wants("visual")) {
    for (const size of sizes) {
      const page = await pageAt(size);
      result.visual[size.id] = {};
      for (const state of states.filter((id) => FULL_SIZES.has(size.id) || CORE_STATES.includes(id) || (PHONE_SIZES.has(size.id) && (id.startsWith("phone-") || PHONE_EXTRA_STATES.includes(id))))) {
        const rect = await mount(page, state, size);
        if (!rect) {
          result.visual[size.id][state] = "unavailable";
          continue;
        }
        await page.evaluate("window.scrollTo(0, 0)");
        const clip = rect.width > 0 && rect.height > 0 ? rect : { x: 0, y: 0, width: size.width, height: size.height };
        const shot = async () =>
          (await page.pw.screenshot({ type: "png", animations: "disabled", clip: { x: clip.x, y: clip.y, width: Math.min(clip.width, size.width), height: Math.min(clip.height, size.height) } })).toString("base64");
        // A stable-frame check: capture until two shots 100 ms apart are byte-equal (an async PDF preview,
        // a late paint), for up to 3 s; the last shot is kept either way.
        let data = await shot();
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const next = await shot();
          const same = next === data;
          data = next;
          if (same) break;
        }
        const signature = await page.evaluate(`window.__signature(${JSON.stringify(data)})`);
        signature.sha256 = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
        result.visual[size.id][state] = signature;
        const file = join(outDir, size.id, `${state}.png`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(data, "base64"));
      }
      console.log(`visual  ${size.id.padEnd(7)} ${Object.keys(result.visual[size.id]).length} captures`);
    }
  }

  if (wants("axe") && wide) {
    const page = await pageAt(wide);
    for (const state of states) {
      if (!(await mount(page, state, wide))) continue;
      result.axe[state] = await page.evaluate("window.__axe()");
    }
    // The phone tier: its own states and the core ones, at the phone's size.
    const phone = sizes.find((size) => size.id === "phone");
    if (phone) {
      const phonePage = await pageAt(phone);
      for (const state of states.filter((id) => CORE_STATES.includes(id) || id.startsWith("phone-") || PHONE_EXTRA_STATES.includes(id))) {
        if (!(await mount(phonePage, state, phone))) continue;
        result.axe[`phone:${state}`] = await phonePage.evaluate("window.__axe()");
      }
    }
    const total = Object.values(result.axe).reduce((sum, list) => sum + list.length, 0);
    console.log(`axe     ${Object.keys(result.axe).length} states, ${total} violation nodes`);
  }

  if (wants("keyboard") && wide) {
    const page = await pageAt(wide);
    await mount(page, "canvas", wide);
    await page.evaluate("window.__focusStart()");
    for (let count = 0; count < TAB_PRESSES; count += 1) {
      await page.pw.keyboard.press("Tab");
      result.keyboard.push(await page.evaluate("window.__focus()"));
    }
    console.log(`keys    ${TAB_PRESSES} Tab presses, ${new Set(result.keyboard).size} distinct stops`);
    // A phone's walk: top row, bottom bar, canvas, the selection bar.
    const phone = sizes.find((size) => size.id === "phone");
    if (phone) {
      const phonePage = await pageAt(phone);
      await mount(phonePage, "selected", phone);
      await phonePage.evaluate("window.__focusStart()");
      result.keyboardPhone = [];
      for (let count = 0; count < 20; count += 1) {
        await phonePage.pw.keyboard.press("Tab");
        result.keyboardPhone.push(await phonePage.evaluate("window.__focus()"));
      }
    }
  }

  // The canvas's inertness: the page reports, for the selected-field
  // state and the preview, which parts of the drawn canvas carry `inert`; the contract is checked here.
  // Measured, not baselined: a failure fails the run.
  if (wants("inert") && wide) {
    const page = await pageAt(wide);
    await mount(page, "selected", wide);
    const edit = await page.evaluate("window.__inertChecks({ preview: false })");
    const tree = await treeProblems(page).catch((error) => ({ problems: [`the accessibility tree could not be read: ${error.message}`], nodes: 0, leaves: 0 }));
    await mount(page, "selected", wide);
    const preview = await page.evaluate("window.__inertChecks({ preview: true })");
    result.inert = { edit, preview, tree };
    const problems = [...tree.problems];
    if (edit.fields === 0) problems.push("no field node on the edit canvas to check");
    if (edit.fieldsWithoutInertLeaf.length > 0) problems.push(`field leaves without inert in edit mode: ${edit.fieldsWithoutInertLeaf.join(", ")}`);
    if (edit.inertOutsideLeaves.length > 0) problems.push(`inert on something that is not a field's leaf: ${edit.inertOutsideLeaves.join(", ")}`);
    if (edit.containers === 0) problems.push("no container node on the edit canvas to check");
    if (edit.inertContainers.length > 0) problems.push(`container shells inside inert: ${edit.inertContainers.join(", ")}`);
    if (edit.nodesOutsideTree.length > 0) problems.push(`nodes out of the accessibility tree (inert or hidden ancestors): ${edit.nodesOutsideTree.join(", ")}`);
    if (edit.nodesWithoutTabindex.length > 0) problems.push(`nodes without the canvas's tabindex model: ${edit.nodesWithoutTabindex.join(", ")}`);
    if (edit.focusableInLeaves > 0) problems.push(`${edit.focusableInLeaves} control(s) inside an inert leaf took focus`);
    if (!preview.previewing) problems.push("the canvas did not enter preview");
    if (preview.inertCount > 0) problems.push(`${preview.inertCount} element(s) are inert in the preview`);
    if (preview.fields === 0) problems.push("no field drawn in the preview to check");
    for (const problem of problems) {
      console.error(`inert   ${problem}`);
      exitCode = 1;
    }
    console.log(`inert   edit: ${edit.fields - edit.fieldsWithoutInertLeaf.length} of ${edit.fields} field leaves inert, ${edit.containers} container shells live; preview: ${preview.inertCount} inert ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  }

  // The canvas's tags: a container's type chip never meets the text of a legend or
  // heading drawn at its own top or its parent's, and the always-shown hidden tag sits on its own
  // node's top edge and takes the pointer. Measured on the data grid state, which holds a hidden
  // field and two containers. Not baselined: a failure fails the run.
  if (wants("chips") && wide) {
    const page = await pageAt(wide);
    await mount(page, "datagrid", wide);
    const chips = await page.evaluate("window.__chipChecks()");
    result.chips = chips;
    const problems = [...chips.chipOverHeading, ...chips.hiddenTagOffEdge.map((entry) => `hidden tag off its node's top edge: ${entry}`), ...chips.hiddenTagNoPointer.map((id) => `hidden tag takes no pointer: ${id}`)];
    if (chips.chips === 0) problems.push("no container type chip on the canvas to check");
    if (chips.hiddenTags === 0) problems.push("no hidden tag on the canvas to check");
    for (const problem of problems) {
      console.error(`chips   ${problem}`);
      exitCode = 1;
    }
    console.log(`chips   ${chips.chips} type chip(s) clear of ${chips.containers} container(s)' headings, ${chips.hiddenTags} hidden tag(s) on their edge ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  }

  // The phone's sheets: the inspector's body must stay usable at the smallest tier, the
  // handle must be a 44 px target, a held drag must have moved the sheet, and the scrim must keep the page's
  // touch. Measured, not baselined: a failure fails the run.
  if (wants("sheets")) {
    result.sheets = {};
    for (const size of sizes.filter((entry) => PHONE_SIZES.has(entry.id))) {
      const page = await pageAt(size);
      result.sheets[size.id] = {};
      for (const state of ["phone-edit", "phone-sheet-drag", "phone-try-results-drag"]) {
        if (onlyStates.length > 0 && !onlyStates.includes(state)) continue;
        if (!(await mount(page, state, size))) continue;
        result.sheets[size.id][state] = await page.evaluate("window.__sheetChecks()");
      }
      const edit = result.sheets[size.id]["phone-edit"];
      const dragged = result.sheets[size.id]["phone-sheet-drag"];
      const results = result.sheets[size.id]["phone-try-results-drag"];
      const problems = [];
      if (edit) {
        if (edit.grab && edit.grab.height < 44) problems.push(`the handle is ${edit.grab.height} px tall (44 wanted)`);
        if (edit.inspectorBody && edit.inspectorBody.height < 150) problems.push(`the inspector's body shows ${edit.inspectorBody.height} px (150 wanted)`);
        if (size.id === "phone-small" && !edit.tall) problems.push("the inspector's sheet does not open tall at 320x568");
        if (edit.scrimTouchAction !== "none") problems.push(`the scrim's touch-action is ${edit.scrimTouchAction} (none wanted)`);
        if (size.layout === "contained" && !edit.bodyScrollLocked) problems.push("the page is not scroll-locked under the sheet in the contained layout");
      }
      if (dragged && dragged.dragged.length === 0) problems.push("a held drag on the handle left the sheet where it was");
      if (results && results.dragged.length === 0) problems.push("a held touch drag left the results sheet where it was");
      for (const problem of problems) {
        console.error(`sheets  ${size.id}: ${problem}`);
        exitCode = 1;
      }
      console.log(`sheets  ${size.id.padEnd(11)} ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
    }
  }

  const logged = [...new Set([...pages.values()].flatMap((page) => page.console))];
  if (logged.length > 0) {
    console.log("\npage console:\n" + logged.map((line) => `  ${line}`).join("\n"));
  }
} catch (error) {
  console.error(`\nbuilder-browser: ${error instanceof Error ? error.message : String(error)}`);
  await chrome.close();
  process.exit(1);
}
await chrome.close();

const record = {
  "//": "The builder's browser baseline: visual signatures per size tier × state, axe violations, the Tab order and keystroke-to-paint, written on Playwright's Chromium against the live renderer. Written by `npm run builder:browser` in packages/datum; `--check` compares. Visual and timing entries are bound to the platform below.",
  platform: process.platform,
  chrome: chrome.version,
  thresholds: { ...THRESHOLDS, perf: PERF_SLACK },
  ...result
};
const candidatePath = join(outDir, "baseline.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(candidatePath, `${JSON.stringify(record, null, 2)}\n`);

if (check) {
  if (!existsSync(baselinePath)) {
    console.error(`\nbuilder-browser: no baseline at ${baselinePath} — run \`npm run builder:browser\` to write it`);
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(baselinePath, "utf8"));
  const samePlatform = committed.platform === process.platform;
  const binding = [];
  const advisory = [];
  const platformBound = samePlatform || strict ? binding : advisory;

  for (const [sizeId, captures] of Object.entries(result.visual)) {
    const before = committed.visual?.[sizeId] ?? {};
    for (const [state, after] of Object.entries(captures)) {
      const prior = before[state];
      if (after === "unavailable" || prior === "unavailable") {
        if (after !== prior) platformBound.push(`visual ${sizeId}/${state}: ${prior ?? "no baseline"} → ${after === "unavailable" ? "unavailable" : "captured"}`);
        continue;
      }
      const why = drift(prior, after);
      if (why) platformBound.push(`visual ${sizeId}/${state}: ${why}`);
    }
  }
  const key = (entry) => `${entry.ruleId} ${entry.target}`;
  for (const [state, after] of Object.entries(result.axe)) {
    const before = new Set((committed.axe?.[state] ?? []).map(key));
    const now = new Set(after.map(key));
    for (const entry of now) if (!before.has(entry)) binding.push(`axe ${state}: new violation ${entry}`);
    for (const entry of before) if (!now.has(entry)) advisory.push(`axe ${state}: fixed ${entry} (rewrite the baseline to keep it fixed)`);
  }
  if (result.keyboard.length > 0) {
    const before = committed.keyboard ?? [];
    const first = result.keyboard.findIndex((stop, index) => stop !== before[index]);
    if (first >= 0) binding.push(`keyboard: Tab ${first + 1} lands on ${result.keyboard[first]} (was ${before[first] ?? "nothing"})`);
  }
  if ((result.keyboardPhone ?? []).length > 0) {
    const before = committed.keyboardPhone ?? [];
    const first = result.keyboardPhone.findIndex((stop, index) => stop !== before[index]);
    if (first >= 0) binding.push(`keyboard (phone): Tab ${first + 1} lands on ${result.keyboardPhone[first]} (was ${before[first] ?? "nothing"})`);
  }
  for (const [fields, after] of Object.entries(result.perf)) {
    // Every timed kind the tier reports (keystroke and commit for a form; open, keystroke and search for the
    // Languages grid), each against the baseline's median where it has one.
    for (const kind of Object.keys(after).filter((name) => typeof after[name]?.median === "number")) {
      const before = committed.perf?.[fields]?.[kind];
      if (!before) continue;
      const limit = before.median * PERF_SLACK.factor + PERF_SLACK.ms;
      if (after[kind].median > limit) platformBound.push(`perf ${fields} fields, ${kind}: median ${after[kind].median} ms over ${Math.round(limit * 10) / 10} (baseline ${before.median})`);
    }
  }

  if (advisory.length > 0) {
    console.log(`\nbuilder-browser: advisory${samePlatform ? "" : ` (baseline written on ${committed.platform}, this is ${process.platform})`}:\n${advisory.map((line) => `  ${line}`).join("\n")}`);
  }
  if (binding.length > 0) {
    console.error(`\nbuilder-browser: differs from visual/builder-baseline/baseline.json — look under ${outDir}, then \`npm run builder:browser\` to accept:\n${binding.map((line) => `  ${line}`).join("\n")}`);
    exitCode = 1;
  } else {
    console.log("\nbuilder-browser: matches visual/builder-baseline/baseline.json");
  }
} else if (!partial) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nbuilder-browser: baseline → visual/builder-baseline/baseline.json; PNGs under ${outDir}`);
} else {
  console.log(`\nbuilder-browser: a partial run (--only, --size, --state) never rewrites the baseline; results in ${candidatePath}`);
}
process.exit(exitCode);
