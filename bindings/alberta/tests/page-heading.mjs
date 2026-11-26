#!/usr/bin/env node
// A journey page's heading takes the form's level (PageState.headingLevel): h1 by default, h3 under a
// form at level 3, focusable by script, with the progress caption above it and the buttons as
// goa-buttons. Real headless Chromium over the tester's own host page and build.
//   node tests/page-heading.mjs [--port 5412]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : 5412;
const doc = JSON.parse(readFileSync(join(repo, "bindings", "alberta", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: doc.stylesheets.map(source), scripts: doc.scripts.map(source) };

const built = await buildRun({ binding: join(here, "..", "src", "index.ts"), name: "alberta-page" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "alberta")], builds: [built] });
let failed = 0;
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failed += 1;
};
try {
  const c = await openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets });
  const read = await c.page.evaluate(async ({ hostUrl, bindingUrl, journey, level }) => {
    const dm = await import(hostUrl);
    const module = await import(bindingUrl);
    const binding = module.createBinding(dm.lit, dm.createDatumBinding());
    const out = {};
    for (const [name, headingLevel] of [["default", undefined], ["level", level]]) {
      const journeys = await dm.loadJourneyEngine();
      const runtime = dm.createFormRuntime(journey, { journeyEngine: journeys.engine });
      runtime.startJourney(journey.journey.journeys[0].id);
      const host = document.createElement("div");
      document.body.append(host);
      const root = host.attachShadow({ mode: "open" });
      const form = dm.mountLive(root, {
        runtime, binding, datum: dm.createDatumBinding(),
        ...(headingLevel !== undefined ? { headingLevel } : {}),
        journeyKit: journeys.renderKit,
        features: [...dm.createDatumFeatures(), dm.createJourneyPageFeature()]
      });
      await form.ready;
      await form.updated();
      const heading = root.querySelector("[data-journey-heading]");
      out[name] = { tag: heading?.tagName ?? null, tabindex: heading?.getAttribute("tabindex") ?? null, progress: root.querySelector(".datum-goa-progress")?.textContent ?? null, buttons: root.querySelectorAll("goa-button-group goa-button").length };
      form.unmount();
      host.remove();
    }
    return out;
  }, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, journey: FIXTURES.journey.definition, level: 3 });
  check(read.default.tag === "H1", `default page heading is h1 (${read.default.tag})`);
  check(read.level.tag === "H3", `page heading under a form at level 3 is h3 (${read.level.tag})`);
  check(read.level.tabindex === "-1", "the page heading stays focusable by script");
  check(typeof read.default.progress === "string" && read.default.progress.length > 0, `the progress caption is drawn (${read.default.progress})`);
  check(read.default.buttons >= 1, `the page's buttons are goa-buttons in a goa-button-group (${read.default.buttons})`);
} finally {
  await browser.close();
  built.dispose();
}
process.exitCode = failed === 0 ? 0 : 1;
