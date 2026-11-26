#!/usr/bin/env node
// The print fixtures check: every fixture of fixtures.ts printed through the
// renderer's print path, with its answers and blank, rendered to PDF by headless Chromium
// (Playwright), then read back: the PDF's text and boxes through pdf.js, and each page as a PNG.
//
//   node print-fixtures/run.mjs [--only overlap,grid] [--out <dir>] [--port 5000] [--headed]
//
// PRINT_FIXTURE_PORTS=start-end moves the port range (default 5000-5009), so agents sharing a
// machine each keep to their own. pdf.js comes from the engine's node_modules when it has it, else
// from packages/datum' (a devDependency there).
//
// What it checks, per case:
// - the document runs no script and holds no form control (input, select, textarea, button);
// - every answer and label prints in ink (contrast >= 4.5:1 on white, fully opaque): no greyed
//   read-only decoration;
// - the page is the size asked for (A4 595x842 pt, Letter 612x792 pt);
// - the fixture's words are in the PDF's text (answers rendition) or its blank words are, and
//   none of its answers (blank rendition); every label stands on the same page as its answer;
//   tabs, steps and journey pages come in order;
// - no two pieces of text overlap, and no text runs off the page.
//
// Then the print frame under host content security policies (the real presentPrintDocument in a
// host page served with the policy): none, a strict style-src, Trusted Types with the datum-print
// policy allowed, and Trusted Types without it. Under each that allows print, the frame's
// document is styled (its sheets applied, labels and answer rules drawn), the frame is placed off
// the page, and no policy violation is logged; without the policy, print refuses with words that
// name it.
//
// Exit codes: 0 every case passed, 1 a case failed, 4 internal (build, server, browser).
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = join(here, "..");
const engineRequire = createRequire(join(engineDir, "package.json"));
const esbuild = engineRequire("esbuild");

function portRange() {
  const value = process.env.PRINT_FIXTURE_PORTS;
  if (!value) return [5000, 5009];
  const match = /^(\d{1,5})-(\d{1,5})$/.exec(value.trim());
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`PRINT_FIXTURE_PORTS must be "start-end" (got "${value}")`);
  return [Number(match[1]), Number(match[2])];
}
const PORTS = portRange();

const { values: args } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string", default: join(tmpdir(), "datum-print-fixtures") },
    port: { type: "string", default: String(PORTS[0]) },
    headed: { type: "boolean", default: false }
  }
});
const port = Number(args.port);
if (!Number.isInteger(port) || port < PORTS[0] || port > PORTS[1]) {
  console.error(`--port ${args.port} is outside ${PORTS[0]}-${PORTS[1]} (PRINT_FIXTURE_PORTS).`);
  process.exit(4);
}
const out = resolve(args.out);
mkdirSync(out, { recursive: true });

function pdfjsRoot() {
  for (const from of [engineDir, join(engineDir, "..", "packages", "datum")]) {
    try {
      return dirname(createRequire(join(from, "package.json")).resolve("pdfjs-dist/package.json"));
    } catch {
      // next
    }
  }
  throw new Error("pdfjs-dist not found in engine/ or packages/datum/ (npm install there)");
}

const VIEWER = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import * as pdfjs from "/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
window.readPdf = async (url) => {
  const pdf = await pdfjs.getDocument({ url }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => typeof item.str === "string" && item.str.trim() !== "")
      .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], w: item.width, h: item.height || Math.hypot(item.transform[2], item.transform[3]) }));
    pages.push({ width: base.width, height: base.height, png: canvas.toDataURL("image/png"), items });
  }
  return pages;
};
window.viewerReady = true;
</script></body></html>`;

/** WCAG relative luminance of an `rgb()`/`rgba()` colour string. */
const contrastScript = () => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const problems = [];
  const controls = document.querySelectorAll("input, select, textarea, button");
  if (controls.length > 0) problems.push(`${controls.length} form control(s) in the print document`);
  if (document.querySelectorAll("script").length > 0) problems.push("a script in the print document");
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
  if (csp !== "script-src 'none'") problems.push(`CSP meta is ${JSON.stringify(csp)}`);
  for (const element of document.querySelectorAll(".datum-print__answer, .dp-answer, .dp-label, .dp-choice__label, .datum-print td, .datum-print th")) {
    if (!element.textContent.trim()) continue;
    const style = getComputedStyle(element);
    const match = /rgba?\(([^)]+)\)/.exec(style.color);
    const parts = match ? match[1].split(/[ ,/]+/).filter(Boolean).map(Number) : [0, 0, 0, 1];
    const alpha = parts.length > 3 ? parts[3] : 1;
    const contrast = 1.05 / (lum(parts.slice(0, 3)) + 0.05);
    let opacity = 1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    if (contrast < 4.5 || alpha < 1 || opacity < 1) {
      problems.push(`greyed text "${element.textContent.trim().slice(0, 40)}": contrast ${contrast.toFixed(2)}, alpha ${alpha}, opacity ${opacity}`);
    }
  }
  return problems;
};

const squash = (text) => text.replace(/\s+/g, "");

/** Host policies the print frame must hold under; `refuses` is the words print must refuse with. */
const HOST_POLICIES = {
  none: { csp: "" },
  "strict-style": { csp: "default-src 'self'; script-src 'self'; style-src 'self'" },
  "trusted-types": { csp: "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types lit-html datum-print" },
  "trusted-types-without-print": { csp: "script-src 'self'; require-trusted-types-for 'script'; trusted-types lit-html", refuses: /datum-print/ }
};

const HOST_PAGE = '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/host/frame.js"></script></head><body><p>host</p></body></html>';

/** In the host page: present `html` through the frame, look at it once its sheets are in, print nothing. */
const presentInHost = async (html) => {
  let seen;
  try {
    await window.presentPrintDocument(html, document, {
      timeoutMs: 2000,
      selfCheck: (doc) => {
        const frame = document.querySelector("iframe[data-datum-print-frame]");
        const frameStyle = getComputedStyle(frame);
        const label = doc.querySelector(".dp-label");
        const answer = doc.querySelector(".dp-answer");
        const sheets = [...doc.styleSheets, ...(doc.adoptedStyleSheets ?? [])];
        const pageRules = sheets.flatMap((sheet) => [...sheet.cssRules]).filter((rule) => rule.constructor.name === "CSSPageRule").length;
        seen = {
          framePosition: frameStyle.position,
          frameOpacity: frameStyle.opacity,
          frameLeft: frame.getBoundingClientRect().left,
          labelWeight: label ? getComputedStyle(label).fontWeight : "none",
          answerRule: answer ? getComputedStyle(answer).borderBottomWidth : "none",
          pageRules,
          policyMeta: doc.querySelector('head > meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null
        };
        return [];
      },
      beforePrint: () => false
    });
    return { ok: true, seen };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), seen };
  }
};

function checkHost(policy, result, violations) {
  const problems = [];
  if (policy.refuses) {
    if (result.ok) problems.push("printed although the page's Trusted Types do not allow datum-print");
    else if (!policy.refuses.test(result.error)) problems.push(`refused without naming the policy: ${result.error}`);
    return problems;
  }
  if (!result.ok) return [`print threw: ${result.error}`];
  const seen = result.seen;
  if (!seen) return ["the frame was never checked"];
  if (seen.framePosition !== "fixed" || seen.frameOpacity !== "0" || seen.frameLeft > -1000) problems.push(`the frame shows on the page: ${seen.framePosition}, opacity ${seen.frameOpacity}, left ${seen.frameLeft}`);
  if (seen.labelWeight === "400" || seen.labelWeight === "none") problems.push(`labels are unstyled (weight ${seen.labelWeight})`);
  if (seen.answerRule === "0px" || seen.answerRule === "none") problems.push(`answers have no rule (${seen.answerRule})`);
  if (seen.pageRules < 1) problems.push("no @page rule reached the frame");
  if (seen.policyMeta !== "script-src 'none'") problems.push(`the frame's policy meta is ${JSON.stringify(seen.policyMeta)}`);
  for (const violation of violations) problems.push(`policy violation: ${violation}`);
  return problems;
}

function checkCase(printCase, pages, domProblems) {
  const { fixture, rendition, size } = printCase;
  const problems = [...domProblems];
  const [w, h] = size === "A4" ? [595.28, 841.89] : [612, 792];
  pages.forEach((page, index) => {
    if (Math.abs(page.width - w) > 1.5 || Math.abs(page.height - h) > 1.5) {
      problems.push(`page ${index + 1} is ${page.width.toFixed(1)}x${page.height.toFixed(1)} pt, not ${size}`);
    }
  });
  const pageTexts = pages.map((page) => squash(page.items.map((item) => item.str).join("")));
  const all = pageTexts.join("");
  const has = (text) => all.includes(squash(text));
  const pageOf = (text) => pageTexts.findIndex((pageText) => pageText.includes(squash(text)));
  const expect = fixture.expect;
  if (rendition === "answers") {
    for (const text of expect.text) if (!has(text)) problems.push(`missing "${text}"`);
    for (const [label, answer] of expect.together ?? []) {
      const a = pageOf(label);
      const b = pageOf(answer);
      const where = (n) => (n < 0 ? "nowhere" : `page ${n + 1}`);
      if (a < 0 || b < 0 || a !== b) problems.push(`"${label}" (${where(a)}) and its answer "${answer}" (${where(b)}) are not on one page`);
    }
  } else {
    // The paper form's own words stand in the blank and the filled rendition; only the blank one is free of answers.
    for (const text of expect.blankText) if (!has(text)) problems.push(`${rendition}: missing "${text}"`);
    if (rendition === "blank") {
      for (const text of expect.answersOnly) if (has(text)) problems.push(`blank: an answer printed: "${text}"`);
    }
    // The filled form carries the answers in the paper form's boxes: every one must be on the paper.
    if (rendition === "filled") {
      for (const text of expect.filledText ?? expect.answersOnly) if (!has(text)) problems.push(`filled: the answer "${text}" is missing`);
    }
    for (const word of ["Not answered", "Aucune réponse"]) if (has(word)) problems.push(`${rendition}: "${word}" printed`);
  }
  // A panel's look is a class on its group, which the PDF's text cannot show: read it off the document that was printed.
  for (const [id, look] of expect.groupLooks ?? []) {
    const drawn = new RegExp(`data-component-id="${id}"><section class="[^"]*\\bdp-group--${look}\\b`);
    if (!drawn.test(printCase.html)) problems.push(`${rendition}: the group "${id}" is not drawn as the ${look} look (no dp-group--${look})`);
  }
  if (expect.order) {
    let at = -1;
    for (const heading of expect.order) {
      const next = all.indexOf(squash(heading), at + 1);
      if (next < 0 || next < at) problems.push(`"${heading}" out of order`);
      at = Math.max(at, next);
    }
  }
  // Overlapping text and text off the page.
  pages.forEach((page, index) => {
    const boxes = page.items.map((item) => ({ ...item, x0: item.x, x1: item.x + item.w, y0: item.y - item.h * 0.2, y1: item.y + item.h * 0.75 }));
    for (const box of boxes) {
      if (box.x0 < -0.5 || box.x1 > page.width + 0.5 || box.y0 < -0.5 || box.y1 > page.height + 0.5) {
        problems.push(`page ${index + 1}: "${box.str.slice(0, 40)}" runs off the page`);
      }
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        // The 1px transparent screen-reader word ("Chosen") rides over its label by design.
        if (a.h < 2 || b.h < 2) continue;
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ix <= 0.5 || iy <= 0.5) continue;
        const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
        if (smaller > 0 && (ix * iy) / smaller > 0.3) {
          problems.push(`page ${index + 1}: "${a.str.slice(0, 30)}" overlaps "${b.str.slice(0, 30)}"`);
        }
      }
    }
  });
  return problems;
}

async function main() {
  // 1. The fixtures' documents, built under Node through the renderer's print path.
  const buildDir = mkdtempSync(join(tmpdir(), "datum-print-build-"));
  const outfile = join(buildDir, "entry.mjs");
  await esbuild.build({
    entryPoints: [join(here, "entry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
    nodePaths: [join(engineDir, "node_modules")]
  });
  const { printCases } = await import(pathToFileURL(outfile).href);
  const frameBuild = await esbuild.build({
    stdin: {
      contents: 'import { presentPrintDocument } from "./form-engine/render/web-component/print-frame.ts"; window.presentPrintDocument = presentPrintDocument;',
      resolveDir: engineDir,
      sourcefile: "host-frame.ts",
      loader: "ts"
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "warning"
  });
  const frameJs = frameBuild.outputFiles[0].text;
  const only = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const cases = await printCases(only);
  if (cases.length === 0) {
    console.error(`--only ${args.only} matches no fixture.`);
    process.exit(2);
  }

  // 2. pdf.js, served for the reading page.
  const pdfjs = pdfjsRoot();
  const files = new Map([
    ["/", { body: VIEWER, type: "text/html" }],
    ["/pdf.mjs", { body: readFileSync(join(pdfjs, "build", "pdf.min.mjs")), type: "text/javascript" }],
    ["/pdf.worker.mjs", { body: readFileSync(join(pdfjs, "build", "pdf.worker.min.mjs")), type: "text/javascript" }],
    ["/host/frame.js", { body: frameJs, type: "text/javascript" }]
  ]);
  for (const [name, policy] of Object.entries(HOST_POLICIES)) {
    files.set(`/host/${name}`, { body: HOST_PAGE, type: "text/html", ...(policy.csp ? { headers: { "content-security-policy": policy.csp } } : {}) });
  }
  const server = createServer((request, response) => {
    const file = files.get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store", ...(file.headers ?? {}) });
    response.end(file.body);
  });
  await new Promise((done, fail) => server.listen(port, "127.0.0.1", done).on("error", fail));

  const browser = await chromium.launch({ headless: !args.headed });
  const report = [];
  try {
    const context = await browser.newContext();
    const reader = await context.newPage();
    await reader.goto(`http://127.0.0.1:${port}/`);
    await reader.waitForFunction(() => window.viewerReady === true);
    for (const printCase of cases) {
      const page = await context.newPage();
      await page.setContent(printCase.html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.emulateMedia({ media: "print" });
      const domProblems = await page.evaluate(contrastScript);
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      await page.close();
      writeFileSync(join(out, `${printCase.name}.pdf`), pdf);
      writeFileSync(join(out, `${printCase.name}.html`), printCase.html);
      files.set(`/case/${printCase.name}.pdf`, { body: pdf, type: "application/pdf" });
      const pages = await reader.evaluate((url) => window.readPdf(url), `/case/${printCase.name}.pdf`);
      pages.forEach((p, index) => writeFileSync(join(out, `${printCase.name}-p${index + 1}.png`), Buffer.from(p.png.split(",")[1], "base64")));
      const problems = checkCase(printCase, pages, domProblems);
      report.push({
        case: printCase.name,
        bugClass: printCase.fixture.bugClass,
        theme: printCase.theme,
        pages: pages.length,
        size: printCase.size,
        problems,
        text: pages.map((p) => p.items.map((item) => item.str).join(" "))
      });
      console.log(`${problems.length === 0 ? "pass" : "FAIL"}  ${printCase.name} (${printCase.theme}, ${pages.length} page${pages.length === 1 ? "" : "s"})${problems.map((problem) => `\n      ${problem}`).join("")}`);
    }
    // The print frame under host policies, with a basic and a Datum answers document.
    const hostCases = cases.filter((printCase) => printCase.rendition === "answers").filter((printCase, index, all) => all.findIndex((other) => other.theme === printCase.theme) === index);
    for (const [name, policy] of Object.entries(HOST_POLICIES)) {
      for (const printCase of hostCases) {
        const page = await context.newPage();
        const violations = [];
        page.on("console", (message) => {
          if (/Content Security Policy|Trusted Type/i.test(message.text())) violations.push(message.text().slice(0, 200));
        });
        await page.goto(`http://127.0.0.1:${port}/host/${name}`);
        await page.waitForFunction(() => typeof window.presentPrintDocument === "function");
        const result = await page.evaluate(presentInHost, printCase.html);
        await page.close();
        // Without the policy the refusal itself is logged as a violation: expected there.
        const problems = checkHost(policy, result, policy.refuses ? [] : violations);
        const caseName = `host-${name}-${printCase.theme}`;
        report.push({ case: caseName, theme: printCase.theme, problems, seen: result.seen ?? null });
        console.log(`${problems.length === 0 ? "pass" : "FAIL"}  ${caseName}${problems.map((problem) => `\n      ${problem}`).join("")}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  const failed = report.filter((entry) => entry.problems.length > 0);
  console.log(`\n${report.length - failed.length}/${report.length} cases passed; PDFs, PNGs and report.json in ${out}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(4);
});
