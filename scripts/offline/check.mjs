#!/usr/bin/env node
// Draws Datum in a browser that can reach nothing but the server the files come from, and fails on any
// request that tries to leave it. "Nothing phones home" is checked here, not asserted.
//
//   npm run offline:check                         the built bundles (packages/datum/dist) and the
//                                                 binding packs (dist/offline/bindings, `npm run offline:packs`)
//   npm run offline:check -- --bundle <dir>       the same pages over an offline bundle's browser/ and bindings/
//   npm run offline:check -- --url http://host/page [--url …] [--allow-host api.internal]
//                                                 pages of a running deployment instead: a host example, your own
//
// The pages it draws from the files: the form in Datum's own look; the form with its PDF module and the
// validation sandbox (a PDF is rendered, so the kernel, its program and the PDF fonts are fetched); the
// builder; and the form under each binding pack, registered the way a host page registers it, with the
// `integrity` the pack's manifest gives. Each page must come up (datum-ready for a form, a drawn shadow
// tree for the builder; no datum-error, no datum-binding-error; controls drawn), ask no other host for
// anything, and get every local file it asks for.
//
// --csp serves those pages under a Content-Security-Policy, to try a policy before a deployment sets it:
// a page must still come up, and what the policy refused on the way is listed (a design system's own inline
// style, say), not counted as a failure.
//
// A request to another host is refused in the browser before it is sent (lib/watch.mjs), so the run itself
// reaches nothing and gives the same answer on an open network as behind an air gap.
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";

import { REPO } from "./lib/packs.mjs";
import { watchContext } from "./lib/watch.mjs";

const LABEL = "offline:check";
const argv = process.argv.slice(2);
const fail = (message) => {
  console.error(`${LABEL}: ${message}`);
  process.exit(1);
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: npm run offline:check -- [options]

Options:
  --bundle <dir>       check an offline bundle: its browser/ and bindings/ folders
  --browser-dir <dir>  the built bundles; default: packages/datum/dist
  --packs <dir>        the binding packs; default: dist/offline/bindings
  --binding <id>       only this binding's pack (repeatable); default: every pack in the manifest
  --url <url>          check a page of a running deployment instead of the files (repeatable)
  --allow-host <host>  with --url: another host the page may reach (repeatable), such as your own API
  --csp <policy>       serve the check's pages under this Content-Security-Policy; what it refuses is listed
  --report <file>      write the result as JSON
  --timeout <ms>       how long a page may take to come up; default 30000
  --help, -h           this text

Exit 0 when every page came up and none asked another host for anything; 1 otherwise.`);
  process.exit(0);
}
const options = { bindings: [], urls: [], allow: [], timeout: 30000 };
for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at];
  const value = () => (argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[(at += 1)] : fail(`${arg} takes a value.`));
  if (arg === "--bundle") options.bundle = resolve(value());
  else if (arg === "--browser-dir") options.browserDir = resolve(value());
  else if (arg === "--packs") options.packs = resolve(value());
  else if (arg === "--binding") options.bindings.push(value());
  else if (arg === "--url") options.urls.push(value());
  else if (arg === "--allow-host") options.allow.push(value());
  else if (arg === "--csp") options.csp = value();
  else if (arg === "--report") options.report = resolve(value());
  else if (arg === "--timeout") options.timeout = Number(value()) || fail("--timeout takes a number of milliseconds.");
  else fail(`unknown option ${arg} (--help lists them).`);
}
const browserDir = options.browserDir ?? (options.bundle ? join(options.bundle, "browser") : join(REPO, "packages", "datum", "dist"));
const packsDir = options.packs ?? (options.bundle ? join(options.bundle, "bindings") : join(REPO, "dist", "offline", "bindings"));

function loadPlaywright() {
  for (const from of ["packages/conformance-suite", "packages/datum"]) {
    try {
      return createRequire(join(REPO, from, "package.json"))("playwright");
    } catch {
      // try the next package
    }
  }
  return fail("Playwright is not installed: run `npm install` in packages/conformance-suite, then `npx playwright install chromium` there.");
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf"
};

const FORM_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>offline check: form</title>
  </head>
  <body>
    <datum-form id="form"></datum-form>
    <script type="module" src="/check/form.js"></script>
  </body>
</html>
`;

const FORM_SCRIPT = `
      const params = new URLSearchParams(location.search);
      const state = (window.__check = { done: false, ready: false, errors: [], violations: [], pdf: null });
      document.addEventListener("securitypolicyviolation", (event) => state.violations.push(event.effectiveDirective + " refused " + (event.blockedURI || "inline")));
      try {
        const datum = await import("/browser/datum-form.js");
        const form = document.getElementById("form");
        const ready = new Promise((resolve) => form.addEventListener("datum-ready", () => { state.ready = true; resolve(); }, { once: true }));
        for (const name of ["datum-error", "datum-binding-error"]) {
          form.addEventListener(name, (event) => state.errors.push(name + ": " + (event.detail?.message ?? JSON.stringify(event.detail ?? {}))));
        }
        const id = params.get("binding");
        if (id) {
          const manifestUrl = new URL("/bindings/manifest.json", location.href);
          const entry = (await (await fetch(manifestUrl)).json())[id];
          const at = (address) => new URL(address, manifestUrl).pathname;
          const place = (file) => ({
            ...file,
            url: at(file.url),
            ...(file.attributes ? { attributes: Object.fromEntries(Object.entries(file.attributes).map(([key, value]) => [key, value.startsWith("./") ? at(value) : value])) } : {})
          });
          const { createBinding } = await import(at(entry.module));
          datum.bindings.register(datum.bindings.fromFactory(createBinding), {
            assets: { stylesheets: entry.stylesheets.map(place), scripts: entry.scripts.map(place) }
          });
          if (entry.bodyClass) document.body.classList.add(entry.bodyClass);
          if (entry.lang) document.documentElement.lang = entry.lang;
          form.binding = id;
        }
        form.dataSources = { countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }] };
        if (params.has("pdf")) {
          form.setAttribute("pdf", "auto");
          form.setAttribute("wasm", "auto");
        }
        form.setAttribute("src", "/check/form.json");
        await ready;
        await form.validate({ focus: false });
        if (params.has("pdf")) {
          const pdf = await form.renderPdf();
          const bytes = pdf?.bytes ?? pdf;
          state.pdf = bytes?.byteLength ?? bytes?.length ?? bytes?.size ?? 0;
        }
      } catch (error) {
        state.errors.push(String(error?.message ?? error));
      }
      state.done = true;
`;

const BUILDER_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>offline check: builder</title>
    <style>body { margin: 0; } main { height: 100vh; }</style>
  </head>
  <body>
    <main><datum-form-builder id="builder" src="/check/form.json"></datum-form-builder></main>
    <script type="module" src="/check/builder.js"></script>
  </body>
</html>
`;

const BUILDER_SCRIPT = `
      const state = (window.__check = { done: false, ready: false, errors: [], violations: [], pdf: null });
      document.addEventListener("securitypolicyviolation", (event) => state.violations.push(event.effectiveDirective + " refused " + (event.blockedURI || "inline")));
      try {
        await import("/browser/datum-builder.js");
        await customElements.whenDefined("datum-form-builder");
        const builder = document.getElementById("builder");
        builder.addEventListener("datum-error", (event) => state.errors.push("datum-error: " + (event.detail?.message ?? "")));
        for (let frames = 0; frames < 120 && !(builder.shadowRoot && builder.shadowRoot.childElementCount > 0); frames += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        state.ready = Boolean(builder.shadowRoot && builder.shadowRoot.childElementCount > 0);
      } catch (error) {
        state.errors.push(String(error?.message ?? error));
      }
      state.done = true;
`;

/** The number of form controls and design-system elements under `#form` or `#builder`, through every shadow root. */
const COUNT_CONTROLS = `(() => {
  const host = document.getElementById("form") ?? document.getElementById("builder");
  let count = 0;
  const visit = (root) => {
    for (const node of root.querySelectorAll("*")) {
      if (node.matches("input, select, textarea, button")) count += 1;
      if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  if (host?.shadowRoot) visit(host.shadowRoot);
  return count;
})()`;

function serveFiles() {
  const mounts = { "/browser/": browserDir, "/bindings/": packsDir };
  const pages = {
    "/check/form.html": [FORM_PAGE, TYPES[".html"]],
    "/check/form.js": [FORM_SCRIPT, TYPES[".js"]],
    "/check/builder.html": [BUILDER_PAGE, TYPES[".html"]],
    "/check/builder.js": [BUILDER_SCRIPT, TYPES[".js"]],
    "/check/form.json": [readFileSync(join(REPO, "packages", "datum", "demo", "intake-form.json")), TYPES[".json"]]
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (pages[path]) {
      const csp = options.csp && path.endsWith(".html") ? { "content-security-policy": options.csp } : {};
      response.writeHead(200, { "content-type": pages[path][1], "cache-control": "no-store", ...csp }).end(pages[path][0]);
      return;
    }
    for (const [prefix, base] of Object.entries(mounts)) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(base, path.slice(prefix.length)));
      if (file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile()) {
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(response);
        return;
      }
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

const playwright = loadPlaywright();
let browser;
try {
  browser = await playwright.chromium.launch();
} catch (error) {
  fail(`could not start Chromium: ${String(error.message).split("\n")[0]} (npx playwright install chromium in packages/conformance-suite)`);
}

const results = [];
let server;
try {
  if (options.urls.length > 0) {
    // A running deployment: each page is loaded and left to settle; what it asked for is the result.
    for (const url of options.urls) {
      const origin = new URL(url);
      const context = await browser.newContext();
      const watch = watchContext(context, { local: [origin.host, ...options.allow] });
      await watch.attach();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.message)));
      try {
        const response = await page.goto(url, { waitUntil: "load", timeout: options.timeout });
        if (response && response.status() >= 400) errors.push(`the page answered ${response.status()}`);
        await page.waitForLoadState("networkidle", { timeout: options.timeout }).catch(() => errors.push("the page never went quiet (requests still in flight)"));
        await page.waitForTimeout(1000);
      } catch (error) {
        errors.push(String(error.message).split("\n")[0]);
      }
      results.push({ page: url, ...watch.take(), errors, refused: [], controls: null, pdf: null });
      await context.close();
    }
  } else {
    if (!existsSync(join(browserDir, "datum-form.js"))) fail(`${browserDir} has no datum-form.js: build the bundles first (npm run datum:build).`);
    const manifestFile = join(packsDir, "manifest.json");
    if (!existsSync(manifestFile)) fail(`${packsDir} has no manifest.json: write the packs first (npm run offline:packs).`);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const ids = options.bindings.length > 0 ? options.bindings : Object.keys(manifest);
    for (const id of ids) if (!manifest[id]) fail(`${manifestFile} has no pack for ${id}.`);

    server = await serveFiles();
    const origin = `http://127.0.0.1:${server.address().port}`;
    const plans = [
      { page: "form (Datum's own look)", path: "/check/form.html", controls: 3 },
      { page: "form with the PDF module and the validation sandbox", path: "/check/form.html?pdf", controls: 3, pdf: true },
      { page: "builder", path: "/check/builder.html", controls: 3 },
      ...ids.map((id) => ({ page: `form under the ${id} pack`, path: `/check/form.html?binding=${encodeURIComponent(id)}`, controls: 3 }))
    ];
    for (const plan of plans) {
      const context = await browser.newContext();
      const watch = watchContext(context, { local: [new URL(origin).host] });
      await watch.attach();
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error.message)));
      let state = { done: false, ready: false, errors: [], violations: [], pdf: null };
      let controls = 0;
      try {
        await page.goto(`${origin}${plan.path}`, { waitUntil: "load", timeout: options.timeout });
        await page.waitForFunction(() => window.__check?.done === true, undefined, { timeout: options.timeout });
        await page.waitForLoadState("networkidle", { timeout: options.timeout }).catch(() => errors.push("the page never went quiet (requests still in flight)"));
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(500);
        state = await page.evaluate(() => window.__check);
        controls = await page.evaluate(COUNT_CONTROLS);
      } catch (error) {
        errors.push(String(error.message).split("\n")[0]);
        state = (await page.evaluate(() => window.__check).catch(() => undefined)) ?? state;
      }
      errors.push(...state.errors);
      if (!state.ready) errors.push("the page did not come up (no datum-ready)");
      else if (controls < plan.controls) errors.push(`only ${controls} controls were drawn`);
      if (plan.pdf && !(state.pdf > 0)) errors.push("renderPdf() gave no PDF");
      results.push({ page: plan.page, ...watch.take(), errors: [...new Set(errors)], refused: [...new Set(state.violations ?? [])], controls, pdf: plan.pdf ? state.pdf : null });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server?.close();
}

let failed = 0;
for (const result of results) {
  const problems = [
    ...result.outside.map((url) => `asked another host: ${url}`),
    ...result.missing.map((entry) => `a local file was not served: ${entry}`),
    ...result.errors
  ];
  result.ok = problems.length === 0;
  if (!result.ok) failed += 1;
  const facts = [`${result.requests} local requests`, ...(result.controls !== null ? [`${result.controls} controls`] : []), ...(result.pdf ? [`a ${result.pdf}-byte PDF`] : [])].join(", ");
  console.log(`${LABEL}: ${result.ok ? "ok  " : "FAIL"} ${result.page} (${facts})`);
  for (const problem of problems) console.log(`    ${problem}`);
  for (const refusal of result.refused) console.log(`    the policy refused: ${refusal}`);
}
if (options.report) writeFileSync(options.report, `${JSON.stringify({ ok: failed === 0, pages: results }, null, 2)}\n`);
if (failed > 0) fail(`${failed} of ${results.length} pages asked another host for something or did not come up.`);
console.log(`${LABEL}: ${results.length} pages came up and none asked another host for anything.`);
