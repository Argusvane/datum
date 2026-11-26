#!/usr/bin/env node
// Enter in a Fluent text box inside a Datum form. fluent-text-input calls form.requestSubmit() on Enter
// (its own implicit submission, which follows the HTML rules), where Datum's native boxes get the
// browser's. The two must agree: one text box checks the form once (a `submit` the renderer handles),
// two text boxes do nothing, a journey page's Enter is the journey module's and moves the page once.
// The expectations are what the Datum binding does (measured on the same host page with `--binding datum`).
//   node tests/enter-key.mjs [--port 5412]
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRun, FIXTURES, form, openCase, startBrowser } from "../../../packages/conformance-suite/binding-check/api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : 5412;
const doc = JSON.parse(readFileSync(join(repo, "bindings", "fluent", "binding-check.json"), "utf8"));
const source = (item) => (typeof item === "string" ? { url: item } : item);
const assets = { stylesheets: doc.stylesheets.map(source), scripts: doc.scripts.map(source) };

const text = (id, extra = {}) => ({ id, type: "text", configuration: { label: id, ...extra } });
const twoPages = { journey: { journeys: [{ id: "j", name: "J", progress: "count", pages: [{ id: "p1", title: "One", components: ["a"] }, { id: "p2", title: "Two", components: ["b"] }] }] } };
// submits: `submit` events on the form (a journey page's single box also fires one, which the renderer ignores); checked: the summary is drawn.
const SCENARIOS = [
  { name: "one required box, empty: the form is checked once and the summary is drawn", def: form([text("name", { required: true })]), steps: [["focus", "name"], ["key", "Enter"]], expect: { submits: 1, summary: true, page: "" } },
  { name: "one box, typed: the answer is committed and checked once", def: form([text("name", { required: true })]), steps: [["focus", "name"], ["type", "Ada"], ["key", "Enter"]], expect: { submits: 1, summary: false, values: { name: "Ada" }, page: "" } },
  { name: "two boxes: Enter does nothing", def: form([text("a", { required: true }), text("b", { required: true })]), steps: [["focus", "a"], ["key", "Enter"]], expect: { submits: 0, summary: false, page: "" } },
  { name: "a box and a button: the form is checked once", def: form([text("a", { required: true }), { id: "go", type: "button", configuration: { label: "Go", action: "submit" } }]), steps: [["focus", "a"], ["key", "Enter"]], expect: { submits: 1, summary: true, page: "" } },
  { name: "a journey page with two boxes: Enter moves the page once", def: FIXTURES.journey.definition, steps: [["focus", "fullName"], ["type", "Ada"], ["focus", "email"], ["type", "a@b.ca"], ["key", "Enter"]], expect: { submits: 0, summary: false, page: "Step 2 of 2: How to reach you" } },
  { name: "a journey page, a box left empty: Enter checks the page, stays on it", def: FIXTURES.journey.definition, steps: [["focus", "fullName"], ["type", "Ada"], ["key", "Enter"]], expect: { submits: 0, summary: true, page: "Step 1 of 2: About you" } },
  { name: "a journey page with one box: Enter moves the page once (the box's own submit is ignored)", def: form([text("a", { required: true }), text("b")], twoPages), steps: [["focus", "a"], ["type", "Ada"], ["key", "Enter"]], expect: { submits: 1, summary: false, page: "Step 2 of 2: Two" } }
];

const built = await buildRun({ binding: join(here, "..", "src", "index.ts"), name: "fluent-enter" });
const browser = await startBrowser({ port, roots: [join(repo, "bindings", "fluent")], builds: [built] });
let failed = 0;
try {
  for (const scenario of SCENARIOS) {
    const c = await openCase(browser, { hostUrl: built.hostUrl, bindingUrl: built.bindingUrl, assets });
    await c.page.evaluate(`bc.mount(${JSON.stringify({ definition: structuredClone(scenario.def), assets })})`);
    await c.sleep(300);
    const root = `document.querySelector("[data-bc-host]").shadowRoot`;
    await c.page.evaluate(`window.__submits = 0; ${root}.addEventListener("submit", () => { window.__submits += 1; }, true);`);
    for (const [op, arg] of scenario.steps) {
      if (op === "focus") await c.focus(arg);
      else if (op === "type") await c.type(arg);
      else await c.key(arg);
    }
    await c.sleep(500);
    const got = await c.page.evaluate(`(() => { const r = ${root}; return { submits: window.__submits, summary: !!r.querySelector(".datum-live-summary"), page: (r.querySelector("[data-journey-heading]")?.textContent ?? "").trim(), values: bc.values() }; })()`);
    const want = scenario.expect;
    const problems = [];
    for (const key of ["submits", "summary", "page"]) if (got[key] !== want[key]) problems.push(`${key} ${JSON.stringify(got[key])}, expected ${JSON.stringify(want[key])}`);
    for (const [key, value] of Object.entries(want.values ?? {})) if (got.values[key] !== value) problems.push(`answer ${key} ${JSON.stringify(got.values[key])}, expected ${JSON.stringify(value)}`);
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"}  ${scenario.name}${problems.length ? ` (${problems.join("; ")})` : ""}`);
    if (problems.length > 0) failed += 1;
    await c.page.close();
  }
} finally {
  await browser.close();
  built.dispose();
}
process.exitCode = failed === 0 ? 0 : 1;
