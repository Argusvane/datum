// Opens docs pages in headless Chrome and checks every live example on them: the frame loads, an
// element of Datum's is defined and drawn, and nothing is reported as an error. Needs the dev
// server (npm run dev) or a served build.
//
//   node scripts/check-examples.mjs form-on-your-page bootstrap        pages by name
//   node scripts/check-examples.mjs --all                              every page that places <LiveExample>
//   node scripts/check-examples.mjs --base http://localhost:5173/docs/ --shots /tmp/shots iframe
//   node scripts/check-examples.mjs --base http://localhost:8080/docs/ --html --all    a build on a plain static server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const take = (flag) => { const at = args.indexOf(flag); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const base = take("--base") ?? "http://localhost:5173/docs/";
const shots = take("--shots");
// --clips <dir> writes one picture per example (options, code, result and log), for a visual check;
// --width sets the window, --dark the docs' dark appearance, --scale the picture's scale.
const clips = take("--clips");
const width = Number(take("--width") ?? 1280);
const scale = Number(take("--scale") ?? 1);
const dark = args.includes("--dark");
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// A plain static server has no clean URLs: --html asks for <page>.html.
const suffix = args.includes("--html") ? ".html" : "";
const all = args.includes("--all");
const pages = all
  ? readdirSync(join(site, "docs")).filter((name) => name.endsWith(".md") && readFileSync(join(site, "docs", name), "utf8").includes("<LiveExample")).map((name) => name.replace(/\.md$/, ""))
  : args.filter((arg) => !arg.startsWith("--"));
if (pages.length === 0) {
  console.error("check-examples: name the pages to check, or pass --all.");
  process.exit(2);
}

// Runs in the page: every example scrolled into view in turn, then read.
const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deep = (root, sel) => { const found = [...root.querySelectorAll(sel)]; for (const el of root.querySelectorAll("*")) if (el.shadowRoot) found.push(...deep(el.shadowRoot, sel)); return found; };
  const results = [];
  // The page may still be compiling on a dev server: wait for the examples to be placed.
  for (let i = 0; i < 60 && !document.querySelector(".live-example"); i++) await sleep(250);
  for (const example of document.querySelectorAll(".live-example")) {
    example.querySelector(".live-example__result").scrollIntoView();
    let frame;
    for (let i = 0; i < 40 && !frame; i++) { await sleep(250); frame = example.querySelector("iframe"); }
    await sleep(5000);
    const result = { title: example.getAttribute("aria-label"), problems: [] };
    if (example.querySelector(".live-example__missing")) result.problems.push("the bundles are missing from demo/");
    else if (!frame) result.problems.push("no frame");
    else {
      const docs = [frame.contentDocument, ...[...frame.contentDocument.querySelectorAll("iframe")].map((inner) => inner.contentDocument).filter(Boolean)];
      const elements = docs.flatMap((doc) => [...doc.querySelectorAll("datum-form, datum-form-builder")]);
      result.elements = elements.map((el) => el.localName);
      if (elements.length === 0) result.problems.push("the page places no Datum element");
      for (const el of elements) {
        if (!el.shadowRoot) result.problems.push(el.localName + " was never defined");
        else if (deep(el.shadowRoot, "input, select, textarea, button").length === 0) result.problems.push(el.localName + " drew no control");
      }
      result.height = frame.style.height;
    }
    // A result with the builder in it runs wider than the example's own column.
    const box = example.getBoundingClientRect();
    const wide = Math.max(box.width, example.querySelector(".live-example__result").getBoundingClientRect().width);
    result.clip = { x: Math.max(0, box.x + scrollX - 8), y: Math.max(0, box.y + scrollY - 8), width: wide + 16, height: box.height + 16 };
    result.overflow = document.documentElement.scrollWidth > innerWidth;
    result.code = example.querySelector(".live-example__code")?.innerText ?? "";
    result.log = [...example.querySelectorAll(".live-example__log-body > *")].map((e) => (e.querySelector("summary") ?? e).textContent.trim().replace(/^\\S+ \\S+ /, "").slice(0, 160));
    for (const line of result.log) if (/^(datum-error|datum-binding-error|error:)/.test(line)) result.problems.push(line);
    results.push(result);
  }
  window.scrollTo(0, 0);
  return results;
})()`;

const profile = mkdtempSync(join(tmpdir(), "datum-examples-"));
const port = 9400 + Math.floor(Math.random() * 500);
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json()).catch(() => undefined);
  }
  if (!target) throw new Error(`Chrome did not start (${chromePath}); set CHROME to its path.`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  let exceptions = [];
  ws.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data); waiting.delete(data.id); }
    if (data.method === "Runtime.exceptionThrown") exceptions.push(String(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text).slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("vitepress-theme-appearance", ${JSON.stringify(dark ? "dark" : "light")}); } catch {}` });
  if (shots) mkdirSync(shots, { recursive: true });
  if (clips) mkdirSync(clips, { recursive: true });
  for (const page of pages) {
    exceptions = [];
    await send("Page.navigate", { url: new URL(page + suffix, base).href });
    await sleep(3000);
    const answer = await send("Runtime.evaluate", { expression: probe, awaitPromise: true, returnByValue: true });
    const results = answer.result?.result?.value;
    if (!Array.isArray(results) || results.length === 0) {
      failed += 1;
      console.log(`✗ ${page}: no live example found on the page`);
      continue;
    }
    for (const [index, result] of results.entries()) {
      const problems = [...result.problems, ...exceptions.map((text) => `page exception: ${text}`)];
      if (result.overflow) problems.push("the page scrolls sideways");
      if (clips && result.clip) {
        const png = await send("Page.captureScreenshot", { captureBeyondViewport: true, clip: { ...result.clip, scale } });
        if (png.result?.data) writeFileSync(join(clips, `${page}-${index + 1}.png`), Buffer.from(png.result.data, "base64"));
      }
      if (problems.length > 0) failed += 1;
      console.log(`${problems.length > 0 ? "✗" : "✓"} ${page}: ${result.title}  [${(result.elements ?? []).join(", ")}] ${result.height ?? ""}`);
      for (const problem of problems) console.log(`    ${problem}`);
      if (args.includes("--code")) console.log(result.code);
      if (args.includes("--log")) for (const line of result.log) console.log(`    · ${line}`);
    }
    if (shots) {
      const png = await send("Page.captureScreenshot", { captureBeyondViewport: true });
      writeFileSync(join(shots, `${page}.png`), Buffer.from(png.result.data, "base64"));
    }
  }
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed > 0 ? 1 : 0);
