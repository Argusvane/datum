// The tester's driver on Playwright: one browser, one page per case, and the context a case runs
// against. Playwright is an optional peer dependency of @argusvane/datum-conformance-suite used by this
// command alone (server hosts that install the suite for datum-host-check never load it), so it is
// imported lazily and its absence is a preflight error (exit 3).
import { createRequire } from "node:module";
import { PreflightError } from "../build.mjs";
import { startServer } from "../server.mjs";
import { FIXTURES } from "../fixtures/index.mjs";
import { createRouting } from "./routes.mjs";

export class Skip extends Error {}
export class Fail extends Error {}
export { PreflightError };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BROWSERS = ["chromium", "firefox", "webkit"];
const INSTALL_HINT = "install it beside the suite (npm install --save-dev playwright) and fetch a browser (npx playwright install chromium)";

/** Playwright as the suite's own location resolves it (beside the suite, as a peer is installed); a preflight error when it is not there. */
export async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    throw new PreflightError(`datum-binding-check needs Playwright, an optional peer dependency of @argusvane/datum-conformance-suite: ${INSTALL_HINT}.`);
  }
}

/**
 * Starts the server and a headless browser. `roots` are the asset folders the server answers from;
 * `builds` are the in-memory builds (build.mjs) it serves; `port` is a free port at or after the one given
 * (0: any). `routes`, `network` and `offline` are the browser's reach beyond the server (routes.mjs: a binding's
 * assets file lists them); every context the browser makes, `context` and `newContext(options)`, carries them.
 * Resolves to `{ server, browser, context, routing, version, newContext(options), open(path), close() }`.
 */
export async function startBrowser({ port = 0, roots = [], builds = [], browserName = "chromium", playwright, routes = [], network = [], offline = false } = {}) {
  const pw = playwright ?? (await loadPlaywright());
  if (!BROWSERS.includes(browserName)) throw new PreflightError(`unknown browser "${browserName}" (one of ${BROWSERS.join(", ")})`);
  const files = new Map();
  for (const build of builds) for (const [name, file] of build.files) files.set(name, file);
  const server = await listen(port, roots, files);
  let browser;
  try {
    browser = await pw[browserName].launch({ headless: true });
  } catch (error) {
    await server.close();
    const first = String(error?.message ?? error).split("\n")[0];
    throw new PreflightError(`could not start ${browserName} through Playwright: ${first}. ${/executable/i.test(first) ? `Fetch the browser: npx playwright install ${browserName}.` : ""}`.trim());
  }
  const routing = createRouting({ origin: `http://127.0.0.1:${server.port}`, roots, routes, network, offline });
  const newContext = async (options) => {
    const made = await browser.newContext(options);
    await routing.attach(made);
    return made;
  };
  const context = await newContext({ viewport: { width: 1100, height: 1500 } });
  return {
    server,
    browser,
    context,
    routing,
    newContext,
    name: browserName,
    version: `${browserName} ${browser.version()}`,
    async open(path) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}${path}`);
      return page;
    },
    async close() {
      await browser.close().catch(() => undefined);
      await server.close();
    }
  };
}

async function listen(port, roots, files) {
  if (port === 0) return startServer({ port: 0, roots, files });
  // A fixed start: the first free port of the thirty from it, so parallel CI jobs on one machine do not collide.
  let last;
  for (let candidate = port; candidate < port + 30; candidate += 1) {
    try {
      return await startServer({ port: candidate, roots, files });
    } catch (error) {
      last = error;
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new PreflightError(`no free port in ${port}-${port + 29}: ${last?.message ?? ""}`);
}

const KEY_NAMES = { " ": "Space" };

/** Opens a fresh page, loads the host module and the binding into it, and returns the context cases use. */
export async function openCase(browser, { hostUrl, bindingUrl, assets, pageLang, bodyClass, modules = {} }) {
  const page = await browser.open("/binding-check.html");
  await page.waitForFunction("window.bindingCheckReady === true", undefined, { timeout: 30000 });
  if (pageLang) await page.evaluate(`document.documentElement.lang = ${JSON.stringify(pageLang)}`);
  // The host page template's own precondition of a design system (GOV.UK: <body class="govuk-frontend-supported">).
  if (bodyClass) await page.evaluate(`document.body.className = ${JSON.stringify(bodyClass)}`);
  const info = await page.evaluate(`bc.load(${JSON.stringify(hostUrl)}, ${JSON.stringify(bindingUrl)}, ${JSON.stringify(assets)})`);
  const c = {
    page, info, assets, console: [], pageLang,
    // The binding package's print and PDF theme modules, built beside it (the assets file's "print" and "pdf").
    modules,
    ev: (expr) => page.evaluate(expr),
    sleep,
    assert(condition, message) { if (!condition) throw new Fail(message); },
    eq(actual, expected, what) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Fail(`${what ?? "value"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    skip(reason) { throw new Skip(reason); },
    fixture: (name) => structuredClone(FIXTURES[name].definition),
    async mount(name, options = {}) {
      const fixture = FIXTURES[name];
      const payload = { definition: structuredClone(fixture.definition), preset: options.preset ?? fixture.preset, mode: options.mode, locale: options.locale, assets: options.assets, expectFailure: options.expectFailure, stages: options.stages ?? fixture.stages };
      let outcome;
      try {
        outcome = await page.evaluate(`bc.mount(${JSON.stringify(payload)})`);
      } catch (error) {
        throw new Fail(`mount of "${name}" failed: ${String(error.message).split("\n")[0]}`);
      }
      if (!options.keepConsole) await c.takeConsole();
      return outcome;
    },
    async takeConsole() { c.console.push(...(await page.evaluate("bc.consoleTake()"))); return c.console; },
    settle: (ms) => page.evaluate(`bc.settle(${ms ?? 150})`),
    validate: () => page.evaluate("bc.validate()"),
    values: () => page.evaluate("bc.values()"),
    errors: () => page.evaluate("bc.errors()"),
    /** The binding declares an adapter for `type`. */
    has: (type) => info.types[type] !== undefined,
    /** Best answer across the type's adapters: "drawn" or "degraded" beat "none" (an unanswered capability is "none"); undefined when the type has no adapter. */
    cap(type, key) {
      const answers = (info.types[type] ?? []).map((a) => a.capabilities[key] ?? "none");
      if (answers.length === 0) return undefined;
      return answers.find((a) => a === "drawn") ?? answers.find((a) => a === "degraded") ?? "none";
    },
    async mouse(x, y) {
      await page.mouse.move(x, y);
      await page.mouse.down({ button: "left", clickCount: 1 });
      await page.mouse.up({ button: "left", clickCount: 1 });
    },
    /** A real pointer click at the middle of the element `expr` finds (scrolled into view first). */
    async click(expr, what = expr) {
      const rect = await page.evaluate(`(() => { const el = (${expr}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
      if (!rect) throw new Fail(`not found: ${what}`);
      if (rect.w === 0 || rect.h === 0) throw new Fail(`not clickable (no size): ${what}`);
      await c.mouse(rect.x, rect.y);
      await sleep(80);
    },
    /** A script click (for a control a design system hides behind its own tile). */
    async clickEl(expr, what = expr) {
      const ok = await page.evaluate(`(() => { const el = (${expr}); if (!el) return false; el.click(); return true; })()`);
      if (!ok) throw new Fail(`not found: ${what}`);
      await sleep(60);
    },
    /** Types one character at a time as inserted text (beforeinput/input events, the way an input method delivers it). */
    async type(text, gap = 25) {
      for (const ch of text) { await page.keyboard.insertText(ch); await sleep(gap); }
    },
    async key(name) {
      await page.keyboard.press(KEY_NAMES[name] ?? name);
      await sleep(60);
    },
    async focus(id, index = 0, which = 0) {
      const ok = await page.evaluate(`bc.focusControl(${JSON.stringify(id)}, ${index}, ${which})`);
      if (!ok) throw new Fail(`could not focus the control of "${id}"${index ? ` (row ${index + 1})` : ""}: none found, or focus did not reach it`);
    },
    async typeInto(id, text, { index = 0, which = 0, commit = true } = {}) {
      await c.focus(id, index, which);
      await c.type(text);
      if (commit) { await page.evaluate("bc.blur()"); await c.settle(); }
    },
    active: () => page.evaluate("bc.active()"),
    /** A PNG screenshot of the viewport, base64. */
    shot: async () => (await page.screenshot({ type: "png" })).toString("base64")
  };
  return c;
}
