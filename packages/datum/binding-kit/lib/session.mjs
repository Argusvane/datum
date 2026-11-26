// One kit session: the binding under test and the kit's host module built together with the
// conformance suite's host module from the engine's source (esbuild, in memory, `shared`: the kit's
// element and the suite's runtime are one engine), a server on a port of 5200-5219 that serves
// them and the binding package's design-system files, and a headless browser. The equality and
// behaviour checks run on it; `datum-binding-check` has its own session (conformance.ts).
//
// The session is offline: the browser reaches the session's server and nothing else except what the
// binding's assets file (binding-check.json) allows. "routes" answer a third-party URL from the
// binding's pinned packages (GCDS's stylesheet @imports Google Fonts, which would otherwise draw
// from whichever stylesheet Google serves that day); "network" lists a host the design system
// publishes a file on and no pinned package holds, with the reason. Any other request is aborted
// and recorded, and the steps that ran on the session fail on the record (`takeOffline`).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, loadEsbuild, loadPlaywright, PreflightError, readRouting, startBrowser } from "@argusvane/datum-conformance-suite/binding-check";
import { pickPort } from "./ports.mjs";
import { renderAssets, resolveBinding } from "./binding-package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const KIT_HOST = join(here, "..", "host", "entry.ts");
const KIT_PAGE = join(here, "..", "page", "kit-page.js");
const RUN = "/binding-check/run/";

const BLANK = "<!doctype html><title>blank</title><p>another page</p>";

/** The design system's files as the kit page and the renderer take them. */
export function assetsOf(pkg) {
  return renderAssets(pkg.assets);
}

/**
 * Opens a session on a binding (an id, `datum`, or a package description). Resolves to
 * `{ pkg, assets, browser, newPage(options), datumPage(), close() }`.
 */
export async function openSession(binding, { browserName = "chromium", port, viewport = { width: 1100, height: 1500 } } = {}) {
  const pkg = typeof binding === "string" ? resolveBinding(binding) : binding;
  if (!pkg.entry) throw new PreflightError(`bindings/${pkg.id} has no binding module yet (src/index.ts or src/binding.ts, or "binding" in binding-check.json)`);
  const playwright = await loadPlaywright();
  const esbuild = loadEsbuild();
  const built = await buildRun({ binding: pkg.entry, name: pkg.id, extraEntries: { kit: KIT_HOST }, esbuild, shared: true });
  built.files.set("kit/kit-page.js", { contents: readFileSync(KIT_PAGE), type: "text/javascript; charset=utf-8" });
  built.files.set("kit/blank.html", { contents: Buffer.from(BLANK), type: "text/html; charset=utf-8" });
  const roots = pkg.isDatum ? [] : [pkg.dir];
  const chosen = port ?? (await pickPort());
  let browser;
  try {
    browser = await startBrowser({ port: chosen, roots, builds: [built], browserName, playwright, ...readRouting(pkg.assets, pkg.assetsFile ?? `bindings/${pkg.id}/binding-check.json`), offline: true });
  } catch (error) {
    built.dispose();
    throw error;
  }
  const assets = assetsOf(pkg);
  const urls = { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, kitUrl: built.urlOf("kit"), pageUrl: `${RUN}kit/kit-page.js`, blankUrl: `${RUN}kit/blank.html` };
  const origin = `http://127.0.0.1:${browser.server.port}`;
  const context = await browser.newContext({ viewport });
  const pages = new Set();

  /**
   * A fresh host page with the kit page loaded. `bc: true` also loads the binding into the suite's
   * `window.bc` (the page the binding is drawn on); a plain reference page needs only the kit.
   */
  async function newPage({ bc = false, lang, bodyClass, initScript } = {}) {
    const page = await context.newPage();
    pages.add(page);
    const consoleLines = [];
    page.on("console", (message) => { if (/^(warning|error)$/.test(message.type())) consoleLines.push(`${message.type()}: ${message.text().slice(0, 300)}`); });
    page.on("pageerror", (error) => consoleLines.push(`exception: ${String(error.message).slice(0, 300)}`));
    if (initScript) await page.addInitScript(initScript);
    await page.goto(`${origin}/binding-check.html`);
    const prepared = await prepare(page, { bc, lang, bodyClass });
    return { page, ...prepared, console: consoleLines, close: async () => { pages.delete(page); await page.close().catch(() => undefined); } };
  }

  /** Waits for the host page to be ready, then loads the kit page (and, with `bc`, the binding into window.bc). Also what a page needs again after a back navigation. */
  async function prepare(page, { bc = false, lang, bodyClass } = {}) {
    await page.waitForFunction("window.bindingCheckReady === true", undefined, { timeout: 30000 });
    if (lang ?? pkg.assets.lang) await page.evaluate(`document.documentElement.lang = ${JSON.stringify(lang ?? pkg.assets.lang)}`);
    if (bodyClass ?? pkg.assets.bodyClass) await page.evaluate(`document.body.className = ${JSON.stringify(bodyClass ?? pkg.assets.bodyClass)}`);
    await page.evaluate(`import(${JSON.stringify(urls.pageUrl)})`);
    const info = await page.evaluate(`kit.init(${JSON.stringify({ kitUrl: urls.kitUrl, hostUrl: urls.hostUrl, bindingUrl: urls.bindingUrl })})`);
    let bcInfo;
    if (bc) bcInfo = await page.evaluate(`bc.load(${JSON.stringify(urls.hostUrl)}, ${JSON.stringify(urls.bindingUrl)}, ${JSON.stringify(assets)})`);
    return { info, bcInfo };
  }

  return {
    pkg,
    assets,
    urls,
    origin,
    browser,
    context,
    browserName,
    version: browser.version,
    newPage,
    prepare,
    /**
     * What the session's browser did beyond its server since this was last called: `{ problems, notes }`,
     * the requests nothing answered (each fails the step that ran) and the known network dependencies used.
     */
    takeOffline() {
      return { problems: browser.routing.take(), notes: browser.routing.notes() };
    },
    /** What the page-side lint finds wrong in the binding object (page/kit-page.js lintBinding). */
    async lint() {
      const handle = await newPage();
      try {
        return handle.info?.problems ?? [];
      } finally {
        await handle.close();
      }
    },
    async close() {
      for (const page of pages) await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close();
      built.dispose();
    }
  };
}
