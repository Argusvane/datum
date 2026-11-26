// The absent-code check in a real browser. A host may deploy without a
// feature's files (deleted from the server, blocked by a CSP, a 404). For each feature that
// dist/feature-files.json lists (scripts/feature-files.mjs), headless Chromium, driven through
// Playwright (scripts/playwright-driver.mjs), loads the built bundles from a copy of dist/
// in three situations and asserts what jsdom cannot see (requests on the wire, real module-map
// failures, boxes with a size):
//
//   excluded     the feature is left out (a `features` list without it) and its files are deleted:
//                zero requests for them, no error anywhere, the baseline interaction works;
//   deleted      the feature is on and its files are 404: a `datum-error` with message and cause,
//                an inline alert with a size, no uncaught exception, the baseline still works; then
//                the files come back and the retry asks for them again and succeeds;
//   csp-blocked  the same with the files present but blocked (a route that aborts them), a blocked
//                fetch being a failed dynamic import, not a hang (10 s per scenario).
//
// Each scenario names the failure state it expects (failureSelector, plus failureText where the
// state is a generic alert) so an unrelated alert cannot pass; a retry counts only when a restored
// file was served (200) and no load error followed. The form-pdf feature is <datum-form pdf="auto">
// with the PDF files gone: a datum-error and the form's notice (role=alert), then restored.
//
// The renderer's journeys runtime has a row set of its own, `journeys (form)` (see runJourneysForm): the
// `journeys` feature above is the builder's mode.
//
// A second section screenshots the lazy panels' loading and failure cards (Header & footer,
// Variables) at a docked, a medium (one drawer) and a phone size, and
// checks the card has a box inside the builder.
//
//   npm run absent-code:browser                      all features, then the panel cards
//   npm run absent-code:browser -- --feature=pdf     one feature (--feature=panels: the cards only,
//                                                     --feature=journeys-form: the renderer's journeys rows only)
//
// Needs `npm run build` first (exit 2 otherwise). Output: a table, visual/out/absent-code/report.json
// and PNGs of the cards beside it. Exit 1 when any row fails.
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";

import { filesOf, readFeatureTokens } from "./feature-files.mjs";
import { launch, packageRoot, waitFor } from "./playwright-driver.mjs";

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith("--feature="))?.slice("--feature=".length);
const debug = args.includes("--debug");
const dist = join(packageRoot, "dist");
const outDir = join(packageRoot, "visual", "out", "absent-code");
const SCENARIO_TIMEOUT_MS = 10000;

if (!existsSync(join(dist, "datum-builder.js")) || !existsSync(join(dist, "feature-files.json"))) {
  console.error("absent-code-browser: dist/ (with feature-files.json) is missing, run `npm run build` first");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(dist, "feature-files.json"), "utf8"));
const tokens = readFeatureTokens();

// ---------------------------------------------------------------------------------------------
// The static server: a mutable root, a request log, 404 for deleted files, held requests.

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2" };
// One state object per scenario (useServer): a scenario that timed out can neither keep writing
// into the next one's request log nor leave a request held (its holds are released on replacement).
const freshServer = (state = {}) => ({ root: dist, page: "", deleted: new Set(), log: [], ok: [], holds: new Map(), ...state });
let server = freshServer();
function useServer(state) {
  for (const hold of server.holds.values()) hold.release?.();
  server = freshServer(state);
}

const http = createServer(async (request, response) => {
  const mine = server;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  mine.log.push(pathname);
  const send = (status, type, body) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  };
  if (pathname === "/__page.html") return send(200, TYPES[".html"], mine.page);
  if (pathname === "/__blank.html" || pathname === "/__ready") return send(200, TYPES[".html"], "<!doctype html><title>blank</title>");
  for (const [name, hold] of mine.holds) {
    if (pathname.endsWith(name)) await hold.promise;
  }
  const relative = pathname.replace(/^\//, "");
  const file = normalize(join(mine.root, relative));
  if (mine.deleted.has(relative) || !file.startsWith(mine.root + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return send(404, "text/plain", `Not found: ${pathname}`);
  }
  mine.ok.push(pathname);
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => http.listen(Number(process.env.PORT ?? 0), "127.0.0.1", resolve));
const serverPort = http.address().port;

// ---------------------------------------------------------------------------------------------
// The pages: one shared preamble that records what reaches the host, then the element.

const INTAKE = {
  id: "absent-code",
  version: "1.0.0",
  schemaVersion: "1",
  root: {
    id: "root",
    type: "form",
    configuration: { title: "Absent code" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: { default: "Full name" } } }] }
  }
};

const PREAMBLE = `
  window.__events = []; window.__rejections = []; window.__errors = []; window.__submits = []; window.__warns = []; window.__readyCount = 0;
  const warn = console.warn;
  console.warn = (...parts) => { window.__warns.push(parts.map(String).join(" ")); warn.apply(console, parts); };
  document.addEventListener("datum-ready", () => { window.__readyCount = (window.__readyCount || 0) + 1; }, true);
  addEventListener("unhandledrejection", (event) => window.__rejections.push(String(event.reason && event.reason.message || event.reason)));
  addEventListener("error", (event) => window.__errors.push(event.message));
  document.addEventListener("datum-error", (event) => {
    const cause = event.detail && event.detail.cause;
    window.__events.push({ message: event.detail && event.detail.message, hasCause: cause !== undefined, cause: cause === undefined ? null : String(cause && cause.message || cause), causeName: cause && cause.name || null });
  }, true);
  document.addEventListener("datum-submit", (event) => window.__submits.push({ accepted: event.detail.accepted, text: JSON.stringify(event.detail.submission || event.detail.errors || null) }), true);
  window.__deep = (selector, root = document) => {
    const found = [];
    const walk = (node) => { node.querySelectorAll(selector).forEach((element) => found.push(element)); node.querySelectorAll("*").forEach((element) => { if (element.shadowRoot) walk(element.shadowRoot); }); };
    walk(root);
    return found;
  };
  window.__sized = (element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  window.__alerts = () => window.__deep('[role="alert"]').filter(window.__sized).map((element) => element.textContent.trim().replace(/\\s+/g, " ").slice(0, 200));
  window.__failures = (selector, pattern) => window.__deep(selector).filter(window.__sized).map((element) => element.textContent.trim().replace(/\\s+/g, " ").slice(0, 200)).filter((text) => !pattern || new RegExp(pattern, "i").test(text));
  window.__wait = (check, ms = 6000) => new Promise((resolve, reject) => { const started = Date.now(); const tick = () => { let value; try { value = check(); } catch {} if (value) return resolve(value); if (Date.now() - started > ms) return reject(new Error("timed out")); setTimeout(tick, 50); }; tick(); });
`;

/** The intake with a second field and a two-page journey over the two fields: the form the `journeys (form)` rows load. */
const JOURNEY_INTAKE = {
  ...INTAKE,
  root: { ...INTAKE.root, children: { content: [...INTAKE.root.children.content, { id: "email", type: "text", configuration: { label: { default: "Email" } } }] } },
  journey: {
    journeys: [
      {
        id: "apply",
        pages: [
          { id: "first", title: "First page", components: ["fullName"] },
          { id: "second", title: "Second page", components: ["email"] }
        ]
      }
    ]
  }
};

/** The form-pdf page: the intake plus a "Get PDF" button, and a datum-pdf listener that takes the file over (no download). */
const FORM_PDF_SETUP = `
  const withButton = ${JSON.stringify(INTAKE)};
  withButton.root.children.content.push({ id: "pdfButton", type: "button", configuration: { label: "Get PDF", action: "pdf" } });
  element.definition = withButton;
  document.addEventListener("datum-pdf", (event) => { window.__pdfEvent = true; event.preventDefault(); }, true);
`;

/** The attributes as the page writes them: `features` is the explicit list the scenario passes. */
function builderPage(attributes) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>absent code: builder</title></head><body style="margin:0">
<script type="module">
${PREAMBLE}
import "/datum-builder.js";
const element = document.createElement("datum-form-builder");
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) element.setAttribute(name, value);
element.definition = ${JSON.stringify(INTAKE)};
document.body.append(element);
window.__element = element;
window.__textCount = () => (JSON.stringify(element.definition).match(/"type":"text"/g) || []).length;
window.__ready = true;
</script></body></html>`;
}

function formPage(attributes, setup = "", definition = INTAKE) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>absent code: form</title></head><body style="margin:0">
<script type="module">
${PREAMBLE}
import * as DatumForm from "/datum-form.js";
window.__DatumForm = DatumForm;
const element = document.createElement("datum-form");
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) element.setAttribute(name, value);
element.definition = ${JSON.stringify(definition)};
${setup}
document.body.append(element);
window.__element = element;
window.__typeName = (text) => { const input = window.__deep("input")[0]; input.focus(); input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); return input.value; };
window.__ready = true;
</script></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// The features. Each: which page, the attributes with the feature left out / on, the trigger that
// reaches its lazy code, the baseline interaction, and how a failure shows.

/** Every builder token but `leave`: the list that excludes one feature. */
const builderListWithout = (leave) => tokens.builder.filter((token) => token !== leave).join(" ");
const formListWithout = (leave) => tokens.form.filter((token) => token !== leave).join(" ");

const BUILDER_BASELINE = {
  before: "window.__textCount()",
  act: `(async () => { window.__element.controller.add("text"); await window.__wait(() => window.__textCount() > 0); return window.__textCount(); })()`,
  ok: (before, after) => after === before + 1
};

const FEATURES = {
  pdf: {
    page: (list) => builderPage(list ? { features: list } : {}),
    excludedList: builderListWithout("pdf"),
    // The PDF mode chunk is asked for at connect when the PDF side is on and its workspace shown.
    trigger: `(async () => { await new Promise((r) => setTimeout(r, 1200)); window.__element.setWorkspace && window.__element.setWorkspace("pdf"); return true; })()`,
    failureSelector: '[data-mode-failed="pdf"]',
    retrySelector: '[data-mode-retry="pdf"]',
    recovered: `window.__element.pdfMode !== undefined`,
    baseline: BUILDER_BASELINE
  },
  journeys: {
    page: (list) => builderPage(list ? { features: list } : {}),
    excludedList: builderListWithout("journeys"),
    trigger: `(async () => { await new Promise((r) => setTimeout(r, 1200)); window.__element.setWorkspace && window.__element.setWorkspace("journeys"); return true; })()`,
    failureSelector: '[data-mode-failed="journeys"]',
    retrySelector: '[data-mode-retry="journeys"]',
    recovered: `window.__element.journeyMode !== undefined`,
    baseline: BUILDER_BASELINE
  },
  "try-it": {
    page: (list) => builderPage(list ? { features: list } : {}),
    excludedList: builderListWithout("try-it"),
    // The canvas's Try it toggle: the panel's chunk is fetched the first time the form is tried.
    trigger: `(async () => { await window.__wait(() => window.__deep("datum-builder-canvas").length); const canvas = window.__deep("datum-builder-canvas")[0]; canvas.previewing = true; await new Promise((r) => setTimeout(r, 1500)); return true; })()`,
    failureSelector: '[data-try-load="failed"]',
    retrySelector: "[data-try-load-retry]",
    recovered: `window.__deep("[data-try-panel]").some((panel) => !panel.hidden) && window.__deep("[data-try-load-retry]").length === 0`,
    baseline: BUILDER_BASELINE
  },
  wasm: {
    page: (list) => formPage(list ? { features: list, wasm: "auto" } : { wasm: "auto" }),
    excludedList: formListWithout("wasm"),
    trigger: `(async () => { await new Promise((r) => setTimeout(r, 1200)); window.__typeName("Ada Lovelace"); try { await window.__element.submit(); } catch (error) { window.__submitError = String(error && error.message || error); } return true; })()`,
    // The submit that needs the WASM host fails with the chunk's message; any other alert (a required field) does not count.
    failureSelector: '[role="alert"]',
    failureText: "load|unavailable|not available|could not|couldn.t|didn.t|failed|wasm",
    retrySelector: undefined,
    recovered: `window.__submits.some((entry) => entry.accepted)`,
    baseline: {
      before: "0",
      act: `(async () => { const typed = window.__typeName("Ada Lovelace"); return typed === "Ada Lovelace" ? 1 : 0; })()`,
      ok: (_before, after) => after === 1
    }
  },
  // The form's own PDF module (pdf="auto": datum-pdf.js beside the bundle, then the PDF service chunk), reached through
  // downloadPdf(), which the form's "pdf" action button calls. Its files are the builder's `pdf` token (same manifest entry).
  "form-pdf": {
    manifestToken: "pdf",
    timeoutMs: 40000,
    recoveryMs: 25000,
    page: (list) => formPage(list ? { features: list, pdf: "auto" } : { pdf: "auto" }, FORM_PDF_SETUP),
    excludedList: formListWithout("pdf"),
    // The form's own "Get PDF" button (action "pdf"): the path that leaves the notice when the module is missing.
    trigger: `(async () => { await new Promise((r) => setTimeout(r, 800)); const button = window.__deep("button").find((b) => /Get PDF/.test(b.textContent)); if (button) button.click(); await new Promise((r) => setTimeout(r, 600)); return true; })()`,
    // The contract: the form's role=alert notice holding the failure text, and a datum-error.
    failureSelector: '[role="alert"][data-pdf-error]',
    failureText: "pdf",
    retrySelector: undefined,
    // The retried button renders the PDF: the cancelable datum-pdf event arrives and the notice is gone.
    recovered: `window.__pdfEvent === true && window.__deep("[data-pdf-error]").length === 0`,
    baseline: {
      before: "0",
      act: `(async () => { const typed = window.__typeName("Ada Lovelace"); return typed === "Ada Lovelace" ? 1 : 0; })()`,
      ok: (_before, after) => after === 1
    }
  },
  signing: {
    // Every page builds the WebAuthn provider; the chunk is fetched only where signing is allowed.
    page: (list) =>
      formPage(
        list ? { features: list, "sign-with": "webauthn" } : { "sign-with": "webauthn" },
        // The real provider is built even where signing is left out: a host that excludes the feature but still constructs one must not fetch the chunk.
        `element.signingProviders = [window.__DatumForm.createWebAuthnSigningProvider({ rpId: "127.0.0.1", discoverable: true })];`
      ),
    excludedList: formListWithout("signing"),
    trigger: `(async () => { await new Promise((r) => setTimeout(r, 800)); window.__typeName("Ada Lovelace"); try { await window.__element.submit(); } catch (error) { window.__submitError = String(error && error.message || error); } return true; })()`,
    failureSelector: '[role="alert"]',
    failureText: "load|unavailable|not available|could not|couldn.t|didn.t|failed|passkey|sign",
    retrySelector: undefined,
    // No `recovered` expression: headless Chrome has no authenticator, so the signing never completes and any second submit would
    // pass. The retry counts when the restored chunk was served (200) and no further load error followed (see the deleted scenario).
    baseline: {
      before: "0",
      act: `(async () => { const typed = window.__typeName("Ada Lovelace"); return typed === "Ada Lovelace" ? 1 : 0; })()`,
      ok: (_before, after) => after === 1
    }
  }
};

// ---------------------------------------------------------------------------------------------
// The scenario runner.

// Launched inside main() (below), so a failed launch or a bad flag still reaches the cleanup.
let chrome;

const work = mkdtempSync(join(tmpdir(), "datum-absent-code-"));
const rows = [];
const shots = [];

/** The scenario being run: the page(s) it opened, closed on a timeout so its body fails fast and stops. */
let current;

/** Copies dist/ to a directory of its own for a feature, so a deleted file never touches the real build. */
function copyDist(name) {
  const target = join(work, `dist-${name}`);
  cpSync(dist, target, { recursive: true });
  return target;
}

/** Opens a page, wires the network log, runs `body`, and closes: one scenario's browser side. */
async function withPage(prepare, body, contextOptions = {}) {
  const page = await chrome.open("/__blank.html", { viewport: { width: 1440, height: 1000 }, ...contextOptions });
  const scope = current;
  scope?.cleanups.push(() => page.close());
  const requests = [];
  // Every request the page makes, blocked ones included: the browser asked for them.
  page.pw.on("request", (request) => requests.push(new URL(request.url()).pathname));
  // What the browser itself logs (not the page's console calls): the Log domain, which Playwright has no call for.
  page.logs = [];
  const session = await page.cdp();
  session.on("Log.entryAdded", (event) => page.logs.push(event.entry));
  await session.send("Log.enable");
  await prepare(page);
  try {
    return await body(page, requests);
  } finally {
    await page.close();
  }
}

/** Blocks every request for `files` on the page (a trailing * so a retry's ?retry=n URL is blocked too), as a CSP would. */
async function blockFiles(page, files) {
  await unblockFiles(page);
  page.blockHandlers = files.map((file) => ({ pattern: `**/${file}*`, handler: (route) => route.abort("blockedbyclient") }));
  for (const { pattern, handler } of page.blockHandlers) await page.pw.route(pattern, handler);
}

/** Lets the blocked requests through again. */
async function unblockFiles(page) {
  for (const { pattern, handler } of page.blockHandlers ?? []) await page.pw.unroute(pattern, handler);
  page.blockHandlers = [];
}

async function navigate(page) {
  await page.pw.goto(`${chrome.origin}/__page.html`);
  await waitFor(() => page.evaluate("window.__ready === true"), { what: "the page to mount", who: "absent-code-browser" });
}

/**
 * Runs one scenario with a timeout that names it. On a timeout the scenario's pages are closed (its
 * next browser call rejects) and the body is awaited, so nothing of it keeps running into the
 * next scenario; `check` ignores whatever a cancelled body reports after the timeout.
 */
async function scenario(feature, kind, run, timeoutMs = SCENARIO_TIMEOUT_MS) {
  const row = { feature, scenario: kind, pass: false, failure: undefined, details: {} };
  rows.push(row);
  const failures = [];
  const scope = { aborted: false, cleanups: [] };
  current = scope;
  const check = (condition, message) => {
    if (!condition && !scope.aborted) failures.push(message);
  };
  let timer;
  const body = run(check, row.details).catch((error) => {
    if (!scope.aborted) failures.push(error instanceof Error ? error.message : String(error));
  });
  try {
    await Promise.race([
      body,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          failures.push(`scenario ${feature}/${kind} timed out after ${timeoutMs} ms`);
          scope.aborted = true;
          for (const cleanup of scope.cleanups) {
            try {
              cleanup();
            } catch {}
          }
          resolve();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (scope.aborted) {
      // Let the cancelled body unwind (its page is closed) before the next scenario resets the server.
      await Promise.race([body, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    useServer({});
    current = undefined;
  }
  row.pass = failures.length === 0;
  row.failure = failures[0];
  if (failures.length > 1) row.details.allFailures = failures;
  if (debug || !row.pass) console.log(`  ${feature}/${kind}: ${row.pass ? "pass" : `FAIL ${failures.join(" | ")}`}${debug ? `\n${JSON.stringify(row.details, null, 2)}` : ""}`);
}

/** What reached the host and the console, for the assertions every scenario shares. */
async function observe(page, requests, files, spec = {}) {
  const failureArgs = `${JSON.stringify(spec.failureSelector ?? '[role="alert"]')}, ${JSON.stringify(spec.failureText ?? "")}`;
  const state = JSON.parse(await page.evaluate(`JSON.stringify({ events: window.__events, rejections: window.__rejections, errors: window.__errors, alerts: window.__alerts(), failures: window.__failures(${failureArgs}), submitError: window.__submitError || window.__pdfError || null })`));
  const names = new Set(files.map((file) => `/${file}`));
  const requested = [...new Set(requests.filter((path) => names.has(path)))];
  const served = [...new Set(server.log.filter((path) => names.has(path)))];
  const ok = [...new Set(server.ok.filter((path) => names.has(path)))];
  const logged = (page.logs ?? []).filter((entry) => entry.level === "error" && entry.source !== "network").map((entry) => entry.text);
  return { ...state, requested, served, ok, console: [...page.console], logs: logged };
}

/** The console lines an absent file may legitimately leave: the element's own caught-error line, one per datum-error. */
function unexpectedConsole(seen, allowElementLines) {
  const own = seen.console.filter((line) => /^console\.error: \[datum-[a-z-]+\] /.test(line));
  const other = seen.console.filter((line) => !own.includes(line));
  const extra = allowElementLines ? own.slice(Math.max(1, seen.events.length)) : own;
  return [...other, ...extra, ...seen.logs];
}

/** A datum-error that says a file could not be loaded: after a retry that found the files, none may follow. */
const LOAD_FAILURE = /dynamically imported|ChunkLoad|Failed to fetch|failed to load|could not be loaded|didn.t load|404/i;

async function runFeature(token) {
  const spec = FEATURES[token];
  const files = filesOf(manifest, spec?.manifestToken ?? token);
  if (!spec || !files || files.length === 0) {
    console.log(`absent-code-browser: ${token}: skipped (${!files || files.length === 0 ? "no files in the manifest" : "no driver"})`);
    return;
  }
  const timeoutMs = spec.timeoutMs ?? SCENARIO_TIMEOUT_MS;
  const deleted = copyDist(`${token}-deleted`);
  const original = copyDist(`${token}-original`);
  const removeFiles = () => files.forEach((file) => rmSync(join(deleted, file), { force: true }));
  removeFiles();

  // (i) EXCLUDED: the feature is left out of the list, its files are gone, the page is driven through its trigger.
  await scenario(token, "excluded", async (check, details) => {
    useServer({ root: deleted, page: spec.page(spec.excludedList) });
    await withPage(
      async () => {},
      async (page, requests) => {
        await navigate(page);
        const before = Number(await page.evaluate(spec.baseline.before));
        await page.evaluate(spec.trigger);
        const after = Number(await page.evaluate(spec.baseline.act));
        const seen = await observe(page, requests, files, spec);
        Object.assign(details, { requested: seen.requested, events: seen.events, console: seen.console });
        check(seen.requested.length === 0, `requested ${seen.requested.join(", ")} (CDP)`);
        check(seen.served.length === 0, `server saw ${seen.served.join(", ")}`);
        check(seen.events.length === 0, `datum-error fired: ${seen.events.map((entry) => entry.message).join("; ")}`);
        check(seen.rejections.length === 0 && seen.errors.length === 0, `uncaught: ${[...seen.rejections, ...seen.errors].join("; ")}`);
        check(seen.alerts.length === 0, `an alert showed: ${seen.alerts.join("; ")}`);
        check(unexpectedConsole(seen, false).length === 0, `console: ${unexpectedConsole(seen, false).join(" | ")}`);
        check(spec.baseline.ok(before, after), `baseline interaction failed (${before} -> ${after})`);
      }
    );
  }, timeoutMs);

  // (ii) DELETED: on, files 404; then restored, retry.
  await scenario(token, "deleted", async (check, details) => {
    useServer({ root: deleted, page: spec.page(undefined) });
    await withPage(
      async () => {},
      async (page, requests) => {
        await navigate(page);
        const before = Number(await page.evaluate(spec.baseline.before));
        await page.evaluate(spec.trigger);
        await waitFor(() => page.evaluate("window.__events.length > 0"), { what: "datum-error", timeoutMs: 6000, who: `${token}/deleted` }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        const seen = await observe(page, requests, files, spec);
        Object.assign(details, { requested: seen.requested, events: seen.events, alerts: seen.alerts, failures: seen.failures, console: seen.console, logs: seen.logs, submitError: seen.submitError });
        check(seen.events.length > 0, "no datum-error reached the host");
        check(seen.events.every((entry) => entry.message && entry.hasCause), `a datum-error lacks message or cause: ${JSON.stringify(seen.events)}`);
        check(seen.requested.length > 0, "the feature's files were never requested (the trigger did not reach them)");
        check(seen.rejections.length === 0 && seen.errors.length === 0, `uncaught: ${[...seen.rejections, ...seen.errors].join("; ")}`);
        // The feature's own failure state (its selector, and text for a generic alert), not any alert on the page.
        check(seen.failures.length > 0, `no failure state with a box (${spec.failureSelector}${spec.failureText ? ` matching /${spec.failureText}/i` : ""}); alerts seen: ${seen.alerts.join(" | ") || "none"}`);
        check(unexpectedConsole(seen, true).length === 0, `console: ${unexpectedConsole(seen, true).join(" | ")}`);
        const after = Number(await page.evaluate(spec.baseline.act));
        check(spec.baseline.ok(before, after), `baseline interaction failed after the error (${before} -> ${after})`);

        // Retry: the files come back; the retry asks for them again, is served them (200), and no load error follows.
        files.forEach((file) => cpSync(join(original, file), join(deleted, file), { recursive: true, force: true }));
        const asked = seen.requested.length;
        const eventsBefore = seen.events.length;
        server.log = [];
        server.ok = [];
        await page.evaluate(`(() => { window.__submitError = undefined; window.__pdfError = undefined; window.__pdfEvent = undefined; return true; })()`);
        if (spec.retrySelector) {
          const clicked = await page.evaluate(`(() => { const button = window.__deep(${JSON.stringify(spec.retrySelector)}).filter(window.__sized)[0]; if (!button) return false; button.click(); return true; })()`);
          check(clicked, "no Retry button with a box on the failure card");
        } else {
          await page.evaluate(spec.trigger);
        }
        // Recovered = a restored file was served with a 200, the feature's own signal (when it has one) holds, and no load error followed.
        const recovered = await waitFor(async () => server.ok.length > 0 && (!spec.recovered || (await page.evaluate(`!!(${spec.recovered})`))), { what: "recovery", timeoutMs: spec.recoveryMs ?? 5000, who: `${token}/retry` }).catch(() => false);
        const after2 = await observe(page, requests, files, spec);
        const laterEvents = after2.events.slice(eventsBefore);
        Object.assign(details, { retryServed: after2.served.length, retryOk: after2.ok, firstRequests: asked, laterEvents });
        check(after2.served.length > 0, "the retry never asked the server for the files again");
        check(after2.ok.length > 0, "the retry was never served a restored file (200)");
        check(recovered, "the feature did not come back after the retry");
        check(!laterEvents.some((entry) => LOAD_FAILURE.test(`${entry.message} ${entry.cause}`)), `a load error followed the retry: ${JSON.stringify(laterEvents)}`);
        check(!(after2.submitError && LOAD_FAILURE.test(after2.submitError)), `the retried call still failed to load: ${after2.submitError}`);
        if (spec.retrySelector && recovered) {
          check(after2.failures.length === 0, `the error state stayed after the retry: ${after2.failures.join("; ")}`);
        }
      }
    );
  }, timeoutMs);

  // (iii) CSP-BLOCKED: files present, requests blocked in the browser.
  await scenario(token, "csp-blocked", async (check, details) => {
    useServer({ root: original, page: spec.page(undefined) });
    await withPage(
      // A trailing * so a retry's ?retry=n URL is blocked too.
      async (page) => blockFiles(page, files),
      async (page, requests) => {
        await navigate(page);
        const before = Number(await page.evaluate(spec.baseline.before));
        await page.evaluate(spec.trigger);
        await waitFor(() => page.evaluate("window.__events.length > 0"), { what: "datum-error", timeoutMs: 6000, who: `${token}/csp-blocked` }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        const seen = await observe(page, requests, files, spec);
        Object.assign(details, { requested: seen.requested, events: seen.events, alerts: seen.alerts, failures: seen.failures, console: seen.console, logs: seen.logs });
        check(seen.events.length > 0, "no datum-error reached the host for a blocked fetch");
        check(seen.events.every((entry) => entry.message && entry.hasCause), `a datum-error lacks message or cause: ${JSON.stringify(seen.events)}`);
        check(seen.served.length === 0, `the server saw ${seen.served.join(", ")}; the browser should have blocked them`);
        check(seen.rejections.length === 0 && seen.errors.length === 0, `uncaught: ${[...seen.rejections, ...seen.errors].join("; ")}`);
        check(seen.failures.length > 0, `no failure state with a box (${spec.failureSelector}${spec.failureText ? ` matching /${spec.failureText}/i` : ""}); alerts seen: ${seen.alerts.join(" | ") || "none"}`);
        check(unexpectedConsole(seen, true).length === 0, `console: ${unexpectedConsole(seen, true).join(" | ")}`);
        const after = Number(await page.evaluate(spec.baseline.act));
        check(spec.baseline.ok(before, after), `baseline interaction failed after the error (${before} -> ${after})`);
      }
    );
  }, timeoutMs);
}

// ---------------------------------------------------------------------------------------------
// The renderer's journeys runtime: `<datum-form>` loads
// datum-form-journey-engine-chunk-*.js for a form that has journeys, and only then. The existing
// `journeys` row set above is the BUILDER's mode; this one is named `journeys (form)` so both run.
//
//   single-page   a form with no journeys, the journey files deleted: zero requests for them, ready, submit works;
//   excluded      a journey form whose `features` leave journeys out, files deleted: zero requests, one
//                 console warning, the whole form as one page (no journey heading), submit works;
//   deleted       a journey form, files 404: datum-error once with message and cause, the card
//                 ([data-journeys-error], role=alert, Retry) with a box, the renderer hidden (never one
//                 page), no datum-ready, nothing uncaught; then the files come back, Retry asks again
//                 (served 200), datum-ready fires, no further load error, the pages navigate;
//   csp-blocked   the same with the files present but blocked (Network.setBlockedURLs; a trailing * so
//                 ?retry=n is blocked too), then unblocked and retried.

const JOURNEYS_FORM = "journeys (form)";
const JOURNEYS_FORM_ARG = "journeys-form";
const JOURNEYS_CARD = { failureSelector: '[data-journeys-error][role="alert"]', failureText: "form could not be loaded|did not arrive" };

/** What the page shows of the journeys runtime: readiness, the journey headings, the card, the renderer's box, the warnings. */
const JOURNEY_STATE = `JSON.stringify({
  ready: window.__readyCount,
  headings: window.__deep("[data-journey-heading]").filter(window.__sized).map((element) => element.textContent.trim().replace(/\\s+/g, " ")),
  inputs: window.__deep("input").filter(window.__sized).length,
  cards: window.__deep("[data-journeys-error][role='alert']").filter(window.__sized).length,
  retryButtons: window.__deep("[data-journeys-retry]").filter(window.__sized).length,
  rendererHidden: !!(window.__element.renderer && window.__element.renderer.hidden),
  rendererSized: !!(window.__element.renderer && window.__sized(window.__element.renderer)),
  warns: window.__warns,
  submits: window.__submits
})`;

async function runJourneysForm() {
  const files = (filesOf(manifest, "journeys") ?? []).filter((file) => /^datum-form-journey-/.test(file));
  const engineFile = files.find((file) => /^datum-form-journey-engine-chunk-.+\.js$/.test(file));
  if (!engineFile) {
    rows.push({ feature: JOURNEYS_FORM, scenario: "manifest", pass: false, failure: "dist/feature-files.json lists no datum-form-journey-engine-chunk-*.js under journeys", details: {} });
    return;
  }
  const deleted = copyDist("journeys-form-deleted");
  const original = copyDist("journeys-form-original");
  files.forEach((file) => rmSync(join(deleted, file), { force: true }));
  const restoreFiles = () => files.forEach((file) => cpSync(join(original, file), join(deleted, file), { recursive: true, force: true }));
  const spec = JOURNEYS_CARD;
  const timeoutMs = 20000;
  const stateOf = async (page) => JSON.parse(await page.evaluate(JOURNEY_STATE));
  const waitReady = (page, who) => waitFor(() => page.evaluate("window.__readyCount > 0"), { what: "datum-ready", timeoutMs: 6000, who });
  const submitAccepted = async (page, who) => {
    await page.evaluate(`(async () => { window.__typeName("Ada Lovelace"); try { await window.__element.submit(); } catch (error) { window.__submitError = String(error && error.message || error); } return true; })()`);
    await waitFor(() => page.evaluate("window.__submits.length > 0"), { what: "datum-submit", timeoutMs: 5000, who }).catch(() => {});
    return (await stateOf(page)).submits.some((entry) => entry.accepted);
  };
  const common = (check, seen) => {
    check(seen.rejections.length === 0 && seen.errors.length === 0, `uncaught: ${[...seen.rejections, ...seen.errors].join("; ")}`);
  };

  // (i) a form with no journeys never asks for the runtime, however many journey files the host kept or dropped.
  await scenario(JOURNEYS_FORM, "single-page", async (check, details) => {
    useServer({ root: deleted, page: formPage({}) });
    await withPage(
      async () => {},
      async (page, requests) => {
        await navigate(page);
        await waitReady(page, `${JOURNEYS_FORM}/single-page`);
        const accepted = await submitAccepted(page, `${JOURNEYS_FORM}/single-page`);
        const seen = await observe(page, requests, files, spec);
        const state = await stateOf(page);
        Object.assign(details, { requested: seen.requested, events: seen.events, state });
        check(seen.requested.length === 0, `requested ${seen.requested.join(", ")} (CDP)`);
        check(seen.served.length === 0, `server saw ${seen.served.join(", ")}`);
        check(state.ready >= 1, "datum-ready never fired");
        check(accepted, "the submit was not accepted");
        check(seen.events.length === 0, `datum-error fired: ${seen.events.map((entry) => entry.message).join("; ")}`);
        check(state.cards === 0 && seen.alerts.length === 0, `an alert showed: ${seen.alerts.join("; ")}`);
        check(state.warns.length === 0, `console warning: ${state.warns.join(" | ")}`);
        check(unexpectedConsole(seen, false).length === 0, `console: ${unexpectedConsole(seen, false).join(" | ")}`);
        common(check, seen);
      }
    );
  }, timeoutMs);

  // (ii) features leaves journeys out: never requested, one warning, the form stays one page. No
  // `journey` or `page` attribute: the definition's journeys alone raise the one warning (applyJourney).
  await scenario(JOURNEYS_FORM, "excluded", async (check, details) => {
    useServer({ root: deleted, page: formPage({ features: formListWithout("journeys") }, "", JOURNEY_INTAKE) });
    await withPage(
      async () => {},
      async (page, requests) => {
        await navigate(page);
        await waitReady(page, `${JOURNEYS_FORM}/excluded`);
        const accepted = await submitAccepted(page, `${JOURNEYS_FORM}/excluded`);
        const seen = await observe(page, requests, files, spec);
        const state = await stateOf(page);
        Object.assign(details, { requested: seen.requested, events: seen.events, state });
        check(seen.requested.length === 0, `requested ${seen.requested.join(", ")} (CDP)`);
        check(seen.served.length === 0, `server saw ${seen.served.join(", ")}`);
        check(state.ready >= 1, "datum-ready never fired");
        check(state.warns.length === 1 && /journeys/.test(state.warns[0]) && /features list/.test(state.warns[0]), `expected exactly one journeys warning, got ${JSON.stringify(state.warns)}`);
        check(state.headings.length === 0 && state.inputs >= 2, `not one page: headings ${JSON.stringify(state.headings)}, inputs ${state.inputs}`);
        check(accepted, "the submit was not accepted");
        check(seen.events.length === 0, `datum-error fired: ${seen.events.map((entry) => entry.message).join("; ")}`);
        check(state.cards === 0 && seen.alerts.length === 0, `an alert showed: ${seen.alerts.join("; ")}`);
        check(unexpectedConsole(seen, false).length === 0, `console: ${unexpectedConsole(seen, false).join(" | ")}`);
        common(check, seen);
      }
    );
  }, timeoutMs);

  /** The failed state, then (after `recover`) Retry: asked again, served, ready, the pages navigate, no further load error. */
  const failedThenRetried = (kind, recover) => async (check, details) => {
    const blocked = kind === "csp-blocked";
    useServer({ root: blocked ? original : deleted, page: formPage({}, "", JOURNEY_INTAKE) });
    await withPage(
      // A trailing * so a retry's ?retry=n URL is blocked too.
      async (page) => {
        if (blocked) await blockFiles(page, files);
      },
      async (page, requests) => {
        await navigate(page);
        await waitFor(() => page.evaluate("window.__events.length > 0"), { what: "datum-error", timeoutMs: 6000, who: `${JOURNEYS_FORM}/${kind}` }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        const seen = await observe(page, requests, files, spec);
        const state = await stateOf(page);
        Object.assign(details, { requested: seen.requested, events: seen.events, failures: seen.failures, state, console: seen.console, logs: seen.logs });
        check(seen.events.length === 1, `expected one datum-error, got ${seen.events.length}: ${JSON.stringify(seen.events)}`);
        check(seen.events.every((entry) => entry.message && entry.hasCause), `a datum-error lacks message or cause: ${JSON.stringify(seen.events)}`);
        if (blocked) check(seen.served.length === 0, `the server saw ${seen.served.join(", ")}; the browser should have blocked them`);
        else check(seen.requested.length > 0, "the journeys runtime was never requested (a journey form should ask for it)");
        check(seen.failures.length > 0, `no failure state with a box (${spec.failureSelector} matching /${spec.failureText}/i); alerts seen: ${seen.alerts.join(" | ") || "none"}`);
        check(state.cards === 1 && state.retryButtons === 1, `expected one card with one Retry button, got ${state.cards} and ${state.retryButtons}`);
        check(state.rendererHidden && !state.rendererSized, `the renderer is still showing (hidden ${state.rendererHidden}, sized ${state.rendererSized}): the form must not draw as one page`);
        check(state.ready === 0, "datum-ready fired for a form that has no runtime");
        check(state.headings.length === 0, `a journey page was drawn: ${JSON.stringify(state.headings)}`);
        check(unexpectedConsole(seen, true).length === 0, `console: ${unexpectedConsole(seen, true).join(" | ")}`);
        common(check, seen);

        // Retry: the files are served again (or unblocked); the click asks for them anew and the form builds.
        await recover(page);
        server.log = [];
        server.ok = [];
        const eventsBefore = seen.events.length;
        const clicked = await page.evaluate(`(() => { const button = window.__deep("[data-journeys-retry]").filter(window.__sized)[0]; if (!button) return false; button.click(); return true; })()`);
        check(clicked, "no Retry button with a box on the card");
        const recovered = await waitReady(page, `${JOURNEYS_FORM}/${kind}/retry`).then(() => true, () => false);
        const after = await observe(page, requests, files, spec);
        const later = await stateOf(page);
        const laterEvents = after.events.slice(eventsBefore);
        Object.assign(details, { retryServed: after.served, retryOk: after.ok, laterEvents, afterRetry: later });
        check(after.served.includes(`/${engineFile}`), "the retry never asked the server for the journeys runtime again");
        check(after.ok.includes(`/${engineFile}`), "the retry was never served the restored journeys runtime (200)");
        check(recovered && later.ready >= 1, "datum-ready did not fire after the retry");
        check(later.cards === 0 && later.retryButtons === 0, "the card stayed after the retry");
        check(!later.rendererHidden && later.rendererSized, "the renderer did not come back after the retry");
        check(later.headings.some((text) => /First page/.test(text)), `the first journey page is not drawn: ${JSON.stringify(later.headings)}`);
        check(laterEvents.length === 0, `a datum-error followed the retry: ${JSON.stringify(laterEvents)}`);
        // The pages navigate: a real Continue moves to the second page.
        await page.evaluate(`(() => { const button = window.__deep("[data-journey-continue]").filter(window.__sized)[0]; if (button) button.click(); return !!button; })()`);
        const moved = await waitFor(() => page.evaluate(`window.__deep("[data-journey-heading]").some((element) => /Second page/.test(element.textContent))`), { what: "the second page", timeoutMs: 5000, who: `${JOURNEYS_FORM}/${kind}/continue` }).then(() => true, () => false);
        check(moved, "Continue did not reach the second page after the retry");
        common(check, await observe(page, requests, files, spec));
      }
    );
  };
  await scenario(JOURNEYS_FORM, "deleted", failedThenRetried("deleted", async () => restoreFiles()), timeoutMs);
  await scenario(JOURNEYS_FORM, "csp-blocked", failedThenRetried("csp-blocked", (page) => unblockFiles(page)), timeoutMs);
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The lazy panels' cards: before the chunk arrives and after it fails.

const LAYOUTS = [
  { id: "docked", width: 1440, height: 900, mobile: false },
  { id: "medium", width: 1024, height: 768, mobile: false },
  { id: "narrow", width: 768, height: 1024, mobile: false },
  { id: "phone", width: 390, height: 844, mobile: true }
];
const PANELS = [
  { panel: "chrome", token: "header-footer", host: "chrome" },
  { panel: "variables", token: "variables", host: "variables" }
];

async function runPanels() {
  mkdirSync(outDir, { recursive: true });
  for (const { panel, token } of PANELS) {
    const files = filesOf(manifest, token);
    if (!files?.length) {
      console.log(`absent-code-browser: panels/${panel}: skipped (no files in the manifest)`);
      continue;
    }
    const target = copyDist(`panel-${panel}`);
    for (const layout of LAYOUTS) {
      await scenario(`panel:${panel}`, layout.id, async (check, details) => {
        // The chunk is held on the wire while the panel opens, then answered 404.
        const resolvers = [];
        const holds = new Map(
          files.map((file) => {
            let resolve;
            const promise = new Promise((done) => (resolve = done));
            resolvers.push(resolve);
            return [file, { promise, release: resolve }];
          })
        );
        useServer({ root: target, page: builderPage({}), holds });
        files.forEach((file) => rmSync(join(target, file), { force: true }));
        await withPage(
          async () => undefined,
          async (page) => {
            await navigate(page);
            await page.evaluate(`window.__wait(() => window.__element.builder && window.__element.builder.shadowRoot && window.__element.builder.shadowRoot.querySelector("datum-builder-canvas")).then(() => true)`);
            await page.evaluate(`(() => { window.__element.builder.panel = ${JSON.stringify(panel)}; return window.__element.builder.panel; })()`);
            // Loading card: the status the shell draws until the chunk is in.
            const loading = await waitFor(
              () => page.evaluate(`(() => { const card = window.__deep(".logic-state[role='status']").filter(window.__sized)[0]; if (!card) return null; const box = card.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, text: card.textContent.trim(), inside: box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.top >= -1, vw: innerWidth, vh: innerHeight }; })()`),
              { what: "the loading card", timeoutMs: 5000, who: `panel:${panel}/${layout.id}` }
            ).catch(() => null);
            details.loading = loading;
            check(loading !== null, "no loading card with a box while the chunk was held");
            if (loading) {
              check(loading.inside, `the loading card sits outside the viewport: ${JSON.stringify(loading)}`);
              check(loading.text.length > 0, "the loading card has no text");
              const file = join(outDir, `${layout.id}-${panel}-loading.png`);
              writeFileSync(file, await page.pw.screenshot({ type: "png" }));
              shots.push(file);
            }
            // Failure: the held request is answered 404.
            resolvers.forEach((resolve) => resolve());
            const failed = await waitFor(
              () => page.evaluate(`(() => { const card = window.__deep("[data-panel-retry]").filter(window.__sized)[0]; if (!card) return null; const wrap = card.closest(".logic-state, [role='alert']") || card; const box = wrap.getBoundingClientRect(); const alert = window.__deep("[role='alert']").filter(window.__sized)[0]; return { width: box.width, height: box.height, text: wrap.textContent.trim().replace(/\\s+/g, " "), alert: !!alert, inside: box.left >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 && box.top >= -1 }; })()`),
              { what: "the failure card", timeoutMs: 5000, who: `panel:${panel}/${layout.id}` }
            ).catch(() => null);
            details.failed = failed;
            check(failed !== null, "no failure card with a Retry button and a box");
            if (failed) {
              check(failed.alert, "the failure card is not an alert");
              check(failed.inside, `the failure card sits outside the viewport: ${JSON.stringify(failed)}`);
              const file = join(outDir, `${layout.id}-${panel}-failed.png`);
              writeFileSync(file, await page.pw.screenshot({ type: "png" }));
              shots.push(file);
            }
            const seen = JSON.parse(await page.evaluate(`JSON.stringify({ events: window.__events, rejections: window.__rejections, errors: window.__errors })`));
            check(seen.events.some((entry) => entry.message && entry.hasCause), "no datum-error with message and cause");
            check(seen.rejections.length === 0 && seen.errors.length === 0, `uncaught: ${[...seen.rejections, ...seen.errors].join("; ")}`);
          },
          { viewport: { width: layout.width, height: layout.height }, isMobile: layout.mobile }
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------

// The exit code is decided after the cleanup: nothing below calls process.exit inside the try.
let usageError;
try {
  chrome = await launch({ serverPort, serve: false, who: "absent-code-browser", readyPath: "/__ready", viewport: { width: 1440, height: 1000 } }).catch((error) => {
    usageError = `absent-code-browser: ${error instanceof Error ? error.message : String(error)}`;
    return undefined;
  });
  const wanted = only ? [only] : Object.keys(FEATURES);
  if (only && only !== "panels" && only !== JOURNEYS_FORM_ARG && !FEATURES[only]) {
    usageError = `absent-code-browser: no driver for "${only}" (have ${Object.keys(FEATURES).join(", ")}, ${JOURNEYS_FORM_ARG}, panels)`;
  }
  if (chrome && !usageError) {
    for (const token of wanted) {
      if (token === "panels" || token === JOURNEYS_FORM_ARG) continue;
      console.log(`absent-code-browser: ${token} (${filesOf(manifest, FEATURES[token].manifestToken ?? token)?.length ?? 0} files)`);
      await runFeature(token);
    }
    if (!only || only === JOURNEYS_FORM_ARG) {
      console.log(`absent-code-browser: ${JOURNEYS_FORM}`);
      await runJourneysForm();
    }
    if (!only || only === "panels") await runPanels();
  }
} catch (error) {
  console.error(`absent-code-browser: ${error instanceof Error ? error.stack : String(error)}`);
  rows.push({ feature: "(run)", scenario: "crash", pass: false, failure: error instanceof Error ? error.message : String(error), details: {} });
} finally {
  await chrome?.close();
  useServer({});
  http.close();
  rmSync(work, { recursive: true, force: true });
}
if (usageError) {
  console.error(usageError);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------

const widthOf = (key) => Math.max(...rows.map((row) => String(row[key]).length), key.length);
console.log(`\n${"feature".padEnd(widthOf("feature"))}  ${"scenario".padEnd(widthOf("scenario"))}  result  first failing assertion`);
for (const row of rows) {
  console.log(`${row.feature.padEnd(widthOf("feature"))}  ${row.scenario.padEnd(widthOf("scenario"))}  ${row.pass ? "pass  " : "FAIL  "}  ${row.failure ?? ""}`);
}
const removable = Object.fromEntries(Object.entries(manifest.features).filter(([, feature]) => feature.files.length > 0).map(([token, feature]) => [token, { files: feature.files.length, bytes: feature.bytes, gzipBytes: feature.gzipBytes }]));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows, removable, screenshots: shots }, null, 2)}\n`);
console.log(`\nabsent-code-browser: ${rows.filter((row) => row.pass).length}/${rows.length} passed; report ${join(outDir, "report.json")}`);
process.exit(rows.every((row) => row.pass) ? 0 : 1);
