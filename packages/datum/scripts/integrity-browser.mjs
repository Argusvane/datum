// The PDF modules and the pdf.js files held to their hashes, in a real browser, under a strict
// Content-Security-Policy. A static server lays the built folder out as the npm package does
// (`/pkg/dist/...` and `/pkg/integrity.json` beside it) and serves each page with a policy that
// names nothing but its own origin, `blob:` for the modules and the worker imported from the bytes
// checked, and `'wasm-unsafe-eval'` for the image decoders. Headless Chromium, through Playwright:
//
//   form          <datum-form pdf="auto" pdf-integrity pdf-manifest-integrity> renders a PDF: datum-pdf.js
//                 is fetched (never imported by its URL), its fonts are fetched and checked, no
//                 policy violation;
//   form-wrong    the same with a pdf-integrity the module does not match: the PDF is refused with the
//                 digest named, and the module never runs;
//   builder       <datum-form-builder pdf-integrity pdf-pages-integrity pdf-manifest-integrity> draws a
//                 page with a standard-14 font: both modules fetched, the worker fetched and started from
//                 a blob: URL, the font fetched by the page and checked, nothing from pdfjs/iccs/;
//   no-blob-worker the builder's page under a policy without blob: in worker-src: opening the PDF is
//                 refused with the reason, rather than hanging.
//
// Needs `npm run build` first (exit 2 otherwise). Exit 1 when a row fails.
//
//   npm run integrity:browser
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

import { chromium } from "playwright";

import { chromeFromEnvironment, packageRoot } from "./playwright-driver.mjs";

const dist = join(packageRoot, "dist");
const manifestPath = join(packageRoot, "integrity.json");
if (!existsSync(join(dist, "datum-pdf.js")) || !existsSync(manifestPath)) {
  console.error("integrity-browser: dist/ and integrity.json are missing, run `npm run build` first");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestText = readFileSync(manifestPath);
const { createHash } = await import("node:crypto");
const MANIFEST_SRI = `sha384-${createHash("sha384").update(manifestText).digest("base64")}`;
const sri = (path) => manifest.files[path];

const STRICT = "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' blob: data:";
const NO_BLOB_WORKER = STRICT.replace("worker-src blob:", "worker-src 'self'");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".ttf": "font/ttf", ".wasm": "application/wasm" };

/** A page: its policy and its script, a module of its own (the policy allows no inline script). */
function html(policyName, script) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${policyName}</title><script type="module" src="/${script}"></script></head><body></body></html>`;
}

const FORM_DEFINITION = {
  id: "pinned",
  version: "1.0.0",
  schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
  root: { id: "root", type: "form", configuration: { title: "Pinned" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] } }
};

// The form's page script: renders a PDF and says what happened.
const FORM_SCRIPT = (integrity) => `
import "/pkg/dist/datum-form.js";
const el = document.createElement("datum-form");
el.setAttribute("pdf", "auto");
el.setAttribute("pdf-integrity", ${JSON.stringify(integrity)});
el.setAttribute("pdf-manifest-integrity", ${JSON.stringify(MANIFEST_SRI)});
el.definition = ${JSON.stringify(FORM_DEFINITION)};
document.body.append(el);
window.__result = el.renderPdf().then(
  (result) => ({ ok: true, bytes: result.bytes.length, head: String.fromCharCode(...result.bytes.slice(0, 5)) }),
  (error) => ({ ok: false, name: error?.name, message: String(error?.message ?? error) })
);
`;

// One page of text in Helvetica, a standard-14 font pdf.js draws from its standard_fonts/ files.
const PAGE_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj",
  "4 0 obj << /Length 38 >> stream",
  "BT /F1 24 Tf 20 100 Td (Pinned) Tj ET",
  "endstream endobj",
  "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF"
].join("\n");

// The builder's page script: the executor the PDF side would load, then one page drawn.
const BUILDER_SCRIPT = `
import "/pkg/dist/datum-builder.js";
const el = document.createElement("datum-form-builder");
el.setAttribute("pdf-integrity", ${JSON.stringify(sri("datum-pdf.js"))});
el.setAttribute("pdf-pages-integrity", ${JSON.stringify(sri("datum-pdf-pages.js"))});
el.setAttribute("pdf-manifest-integrity", ${JSON.stringify(MANIFEST_SRI)});
window.__result = (async () => {
  try {
    const support = await el.executorLoader()();
    const set = await support.pages.open(new TextEncoder().encode(${JSON.stringify(PAGE_PDF)}));
    const canvas = await set.render(1, { scale: 1 });
    // Some pixel of the text is dark: the page was drawn with the font.
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] < 128) dark += 1;
    set.close();
    return { ok: true, pages: set.pageCount, width: canvas.width, dark };
  } catch (error) {
    return { ok: false, name: error?.name, message: String(error?.message ?? error) };
  }
})();
`;

const PAGES = {
  "/form.html": [STRICT, "form.js"],
  "/form-wrong.html": [STRICT, "form-wrong.js"],
  "/builder.html": [STRICT, "builder.js"],
  "/no-blob-worker.html": [NO_BLOB_WORKER, "builder.js"]
};
const SCRIPTS = {
  "/form.js": FORM_SCRIPT(sri("datum-pdf.js")),
  "/form-wrong.js": FORM_SCRIPT(`sha384-${createHash("sha384").update("another build").digest("base64")}`),
  "/builder.js": BUILDER_SCRIPT
};

let log = [];
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  log.push(path);
  if (PAGES[path]) {
    const [policy, script] = PAGES[path];
    response.writeHead(200, { "content-type": TYPES[".html"], "content-security-policy": policy });
    response.end(html(path, script));
    return;
  }
  if (SCRIPTS[path]) {
    response.writeHead(200, { "content-type": TYPES[".js"] });
    response.end(SCRIPTS[path]);
    return;
  }
  const file = path === "/pkg/integrity.json" ? manifestPath : path.startsWith("/pkg/dist/") ? normalize(join(dist, path.slice("/pkg/dist/".length))) : undefined;
  if (!file || (file !== manifestPath && !file.startsWith(dist + sep)) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const executablePath = chromeFromEnvironment("integrity-browser");
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const rows = [];

async function run(name, path, judge) {
  log = [];
  const page = await browser.newPage();
  const violations = [];
  const errors = [];
  await page.exposeFunction("__violation", (text) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => window.__violation(`${event.violatedDirective} ${event.blockedURI}`));
  });
  page.on("pageerror", (error) => errors.push(error.message));
  let result;
  try {
    await page.goto(`${origin}${path}`);
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 20000 });
    result = await Promise.race([page.evaluate(() => window.__result), new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: "timed out (20 s)" }), 20000))]);
  } catch (error) {
    result = { ok: false, message: `the page did not run: ${error.message}` };
  }
  const problems = judge(result, { requests: [...log], violations, errors });
  rows.push({ name, pass: problems.length === 0, problems, result });
  await page.close();
}

const requestedOnce = (requests, path) => requests.filter((request) => request === path).length === 1;

await run("form", "/form.html", (result, { requests, violations }) => {
  const problems = [];
  if (!result.ok || result.head !== "%PDF-") problems.push(`no PDF: ${JSON.stringify(result)}`);
  if (!requestedOnce(requests, "/pkg/dist/datum-pdf.js")) problems.push("datum-pdf.js was not fetched exactly once");
  if (!requests.includes("/pkg/integrity.json")) problems.push("integrity.json was not fetched");
  if (!requests.includes("/pkg/dist/fonts/DejaVuSans.ttf")) problems.push("the font was not fetched");
  if (violations.length > 0) problems.push(`policy violations: ${violations.join("; ")}`);
  return problems;
});

await run("form-wrong", "/form-wrong.html", (result) => {
  const problems = [];
  if (result.ok) problems.push("the PDF was made from a module that does not match");
  else if (result.name !== "IntegrityError" || !/sha384 digest is sha384-/.test(result.message)) problems.push(`refused, but not for the digest: ${JSON.stringify(result)}`);
  return problems;
});

await run("builder", "/builder.html", (result, { requests, violations }) => {
  const problems = [];
  if (!result.ok || result.pages !== 1 || !(result.dark > 0)) problems.push(`no page drawn: ${JSON.stringify(result)}`);
  for (const path of ["/pkg/dist/datum-pdf.js", "/pkg/dist/datum-pdf-pages.js", "/pkg/dist/pdfjs/pdf.worker.min.mjs"]) {
    if (!requestedOnce(requests, path)) problems.push(`${path} was not fetched exactly once`);
  }
  if (!requests.some((request) => request.startsWith("/pkg/dist/pdfjs/standard_fonts/"))) problems.push("no standard font was fetched through the page");
  if (requests.some((request) => request.startsWith("/pkg/dist/pdfjs/iccs/") || request.includes("nowasm_fallback"))) problems.push("pdf.js fetched a file the manifest mode does not check");
  if (violations.length > 0) problems.push(`policy violations: ${violations.join("; ")}`);
  return problems;
});

await run("no-blob-worker", "/no-blob-worker.html", (result) => {
  const problems = [];
  if (result.ok) problems.push("a page drew although its policy refuses a blob: worker");
  else if (!/worker-src/.test(result.message)) problems.push(`refused, but not saying why: ${JSON.stringify(result)}`);
  return problems;
});

await browser.close();
server.close();

for (const row of rows) {
  console.log(`${row.pass ? "pass" : "FAIL"}  ${row.name.padEnd(15)} ${row.pass ? JSON.stringify(row.result) : row.problems.join(" | ")}`);
}
process.exit(rows.every((row) => row.pass) ? 0 : 1);
