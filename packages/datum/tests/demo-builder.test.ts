import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { until } from "./helpers.js";

/*
 * demo/builder.html: the page's module scripts run in the order a browser runs them, over the
 * elements from source. A module script runs once the document is parsed, each in document order;
 * one with top-level await holds up only the modules that import it, never the scripts after it.
 * The bundle the page names stands in for its source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../demo/builder.html"), "utf8");

/** What each URL the page loads stands for; `topLevelAwait` for a module whose evaluation waits. */
const MODULES: Record<string, { evaluate: () => Promise<unknown>; topLevelAwait?: boolean }> = {
  "/dist/datum-builder.js": { evaluate: () => import("../src/builder.js") }
};

const evaluations = new Map<string, Promise<unknown>>();

/** A module's evaluation, once per page as a browser's module map has it. */
function load(url: string): Promise<unknown> {
  let evaluation = evaluations.get(url);
  if (!evaluation) {
    const module = MODULES[url];
    expect(module, `a stand-in for ${url}`).toBeDefined();
    evaluation = module!.evaluate();
    evaluations.set(url, evaluation);
  }
  return evaluation;
}

const STATIC_IMPORT = /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["'];?[ \t]*$/gm;

/** Runs the page: its body, then its module scripts as a browser runs them. Resolves once every one has finished. */
async function runPage(): Promise<void> {
  const page = new DOMParser().parseFromString(html, "text/html");
  const scripts = [...page.querySelectorAll<HTMLScriptElement>('script[type="module"]')];
  document.body.innerHTML = page.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
  const running: Promise<unknown>[] = [];
  for (const script of scripts) {
    const src = script.getAttribute("src");
    if (src) {
      const evaluation = load(src);
      running.push(evaluation);
      if (!MODULES[src]?.topLevelAwait) {
        await evaluation;
      }
      continue;
    }
    // An inline module: what it imports is evaluated, top-level await and all, before its body.
    const source = script.textContent ?? "";
    const imports = [...source.matchAll(STATIC_IMPORT)].map((match) => match[1]!);
    const body = source.replace(STATIC_IMPORT, "").replace(/\bimport\(/g, "load(");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    running.push(
      (async () => {
        for (const url of imports) {
          await load(url);
        }
        await new AsyncFunction("load", body)(load);
      })()
    );
  }
  await Promise.all(running);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("demo/builder.html", () => {
  it("loads the builder bundle, and the page reports nothing", async () => {
    const sample = readFileSync(resolve(here, "../demo/intake-form.json"), "utf8");
    // The sample form over the network: a later task, as a fetch is.
    vi.stubGlobal("fetch", async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new URL(String(url), location.href).pathname === "/demo/intake-form.json" ? new Response(sample, { status: 200 }) : new Response("", { status: 404 });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPage();
    const builder = document.getElementById("builder") as HTMLElement & { definition?: { id?: string } };
    expect(customElements.get("datum-form-builder")).toBeDefined();
    await until(() => builder.definition?.id === JSON.parse(sample).id);

    // The builder reports a builder theme it cannot resolve on the console and as `datum-error`, which
    // the page's Events card lists.
    const unresolved = errors.mock.calls.map((call) => String(call[0])).filter((message) => /Unknown builder theme/.test(message));
    expect(unresolved).toEqual([]);
    await until(() => document.getElementById("events")!.textContent!.includes("datum-builder-change"));
    expect(document.getElementById("events")!.textContent).not.toContain("datum-error");
    expect(builder.hasAttribute("theme")).toBe(false);
  }, 60_000);
});
