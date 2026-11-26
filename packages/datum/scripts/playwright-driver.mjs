// Headless Chromium through Playwright, shared by the browser tools of this package: the form's
// visual and accessibility baselines (visual-browser.mjs, a11y-browser.mjs), the builder
// harness (builder-browser.mjs), the absent-code scenarios (absent-code-browser.mjs) and the
// agent evaluation (agent-eval.mjs). It starts the package's static server (serve-demo.mjs),
// launches the browser, and hands out pages; each tool keeps its own loop and its own output.
// Playwright's own Chromium is the browser (`npx playwright install chromium`); $CHROME names
// another Chrome or Chromium binary to use instead.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function whichBinary(name) {
  const which = spawnSync("which", [name], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : undefined;
}

/**
 * The binary $CHROME names, or undefined when it is unset (an empty value counts as unset: Playwright's
 * own Chromium is used). A $CHROME that is set but names no binary (a missing file, or a bare name not on
 * PATH) is the person's mistake and is never worked around: it throws, naming the path, instead of falling
 * back to another browser (the agent harness maps the message to its environment exit, 3).
 */
export function chromeFromEnvironment(who = "playwright-driver", env = process.env) {
  const chosen = env.CHROME;
  if (!chosen) return undefined;
  const found = chosen.includes("/") ? (existsSync(chosen) ? chosen : undefined) : whichBinary(chosen);
  if (!found) throw new Error(`${who}: no Chrome found — $CHROME is set to "${chosen}", which names no binary; point it at a Chrome or Chromium binary, or unset it`);
  return found;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(check, { timeoutMs = 20000, every = 100, what = "condition", who = "playwright-driver" } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() - started > timeoutMs) throw new Error(`${who}: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/**
 * Blink's pointer settings for a mouse: a fine primary pointer that hovers. Headless Chromium on Linux
 * reports no pointer at all (`(pointer: none)`, `(hover: none)`; Chrome 145 on the CI runner), so every
 * rule under `@media (hover: hover)` never applies and a hover read measures the rest colour. macOS
 * reports a mouse by itself; the setting changes nothing there. Emulated media features do not reach
 * these queries, so it is a switch of the browser.
 */
const MOUSE_POINTER_SETTINGS = "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

/**
 * One open page. `pw` is Playwright's own Page for anything the tools drive directly (viewport,
 * keyboard, screenshots, routes); `evaluate` runs an expression string on the page, awaiting a promise
 * and returning its value, which is how the tools call the workbench pages' `window.__*` functions; and
 * `console` collects what the page reported as `exception: …` and `console.error: …`.
 */
export class Page {
  constructor(context, page) {
    this.context = context;
    this.pw = page;
    this.console = [];
    this.cdpSession = undefined;
    page.on("pageerror", (error) => this.console.push(`exception: ${error.stack ?? error.message}`));
    // A console API call has arguments; what the browser itself logs (a failed request, a blocked script) arrives
    // as a console message with none, and is read through the Log domain by the tools that want it (`logs`).
    page.on("console", (message) => {
      if (message.type() === "error" && message.args().length > 0) this.console.push(`console.error: ${message.text()}`);
    });
  }

  /** Evaluates `expression` on the page, awaiting a promise, returning its value by value. */
  evaluate(expression) {
    return this.pw.evaluate(expression);
  }

  /** A DevTools Protocol session on the page, for the few things Playwright has no call for (the browser's own Log domain, the accessibility tree). */
  async cdp() {
    this.cdpSession ??= await this.context.newCDPSession(this.pw);
    return this.cdpSession;
  }

  async close() {
    await this.context.close().catch(() => undefined);
  }
}

/**
 * Serves the package over scripts/serve-demo.mjs on `serverPort`, launches headless Chromium, and returns
 * what a tool needs: the browser's version string, an `open(path, contextOptions)` that opens a new page (in
 * a context of its own, so a viewport, `isMobile` or `reducedMotion` is that page's alone) at that path, and
 * `close()` which stops the browser and the server. The default viewport is tall so a long page lays out at
 * once. With `serve: false` it starts no server and uses the one already on `serverPort`, and `close()`
 * leaves that server to its owner. `pointer: "mouse"` makes the browser report a hovering fine pointer
 * wherever it runs (MOUSE_POINTER_SETTINGS); the default leaves the platform's own report. `chromeArgs` are
 * extra command-line switches (the agent harness passes `--enable-features=WebMCP`); `headless: false` shows
 * the window so a run can be watched. `browserType` is the Playwright browser type, injectable for a test.
 */
export async function launch({
  serverPort,
  who = "playwright-driver",
  readyPath = "/demo/index.html",
  viewport = { width: 1280, height: 2400 },
  serve = true,
  pointer = "platform",
  chromeArgs = [],
  headless = true,
  browserType = chromium
}) {
  const executablePath = chromeFromEnvironment(who);
  const server = serve ? spawn(process.execPath, [join(packageRoot, "scripts", "serve-demo.mjs")], { env: { ...process.env, PORT: String(serverPort) }, stdio: "ignore" }) : undefined;
  const origin = `http://127.0.0.1:${serverPort}`;
  let browser;
  try {
    await waitFor(() => fetch(`${origin}${readyPath}`).then((response) => response.ok), { what: "the demo server", who });
    try {
      browser = await browserType.launch({
        headless,
        ...(executablePath ? { executablePath } : {}),
        args: [...(pointer === "mouse" ? [MOUSE_POINTER_SETTINGS] : []), ...chromeArgs]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Executable doesn't exist|playwright install/i.test(message)) {
        throw new Error(`${who}: no Chromium found — run \`npx playwright install chromium\` in packages/datum, or set $CHROME to a Chrome or Chromium binary`);
      }
      throw error;
    }
    return {
      origin,
      version: `Chrome/${browser.version()}`,
      browser,
      async open(path, contextOptions = {}) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...contextOptions });
        const page = new Page(context, await context.newPage());
        await page.pw.goto(`${origin}${path}`);
        return page;
      },
      async close() {
        await browser.close().catch(() => undefined);
        server?.kill("SIGKILL");
      }
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGKILL");
    throw error;
  }
}

/** Object keys sorted recursively, so two JSON documents compare by content. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])])
    );
  }
  return value;
}

/** Lines describing how `after` differs from `before` (arrays by entry, objects by key). */
export function diff(before, after, path = "") {
  const lines = [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeKeys = new Set(before.map((entry) => JSON.stringify(entry)));
    const afterKeys = new Set(after.map((entry) => JSON.stringify(entry)));
    for (const entry of before) if (!afterKeys.has(JSON.stringify(entry))) lines.push(`  - ${path}: ${JSON.stringify(entry)}`);
    for (const entry of after) if (!beforeKeys.has(JSON.stringify(entry))) lines.push(`  + ${path}: ${JSON.stringify(entry)}`);
    return lines;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      lines.push(...diff(before[key], after[key], path ? `${path}.${key}` : key));
    }
    return lines;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) lines.push(`  ~ ${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  return lines;
}
