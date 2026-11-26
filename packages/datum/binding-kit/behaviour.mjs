#!/usr/bin/env node
// Behaviour: the states a page puts a binding through that the conformance corpus
// (`datum-binding-check`) does not: leaving and coming back, autofill, and moving the host in the
// DOM. One suite for every binding, binding-agnostic: it names no class or tag of a design system,
// it draws a small form through the binding and looks at what a person and the page see.
//
//   node binding-kit/behaviour.mjs --binding govuk [--only BF-01,AF-01] [--browser chromium]
//
//   BF-01  back/forward without the page cache: the page loads again, the form is drawn again with
//          the answers the page kept, in the design system's look (assets fetched again, nothing stale)
//   BF-02  a page-cache restore (pageshow, persisted): the form stays drawn and takes input
//   AF-01  autofill on a text field (value set, input with insertReplacementText, change; no keys)
//          reaches the answer and survives a redraw
//   AF-02  autofill on a select (skipped when the field draws a [role=combobox] listbox and no native <select>: a browser autofills only a native one)
//   AF-03  a field's `autocomplete` token reaches the control a browser autofills
//   MV-01  the form element taken out and put back in the same task keeps its form
//   MV-02  the element put back later draws again: answers kept, the design system's look, no errors
//   MV-03  a host the renderer was mounted on (mountLive) moved in the DOM keeps working
//   MV-04  the element removed for good takes its sheets and fonts with it
//
// A case that fails because of a defect of the design system itself is declared in the binding's
// binding-check.json (`known`: case, reason, since). A binding never patches or works around a design system's
// defect, so the run reports such a case as `known` with its reason, counted apart from pass and fail, and the step
// exits 0 when only known cases are left. A listed case that passes is a problem ("listed as known but passes:
// remove it"), so the list cannot hide a fix.
//
// A case whose subject the binding does not draw (no adapter for the type: Datum draws it) is reported as
// skipped with the reason, never counted as a difference. Required in Chromium, Firefox and WebKit (only Chromium is installed
// where this was written; the others run when Playwright has their browsers).
//
// Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CASES as CONFORMANCE_CASES, PreflightError, readRouting } from "@argusvane/datum-conformance-suite/binding-check";
import { formOf } from "./lib/reference.mjs";
import { resolveBinding } from "./lib/binding-package.mjs";
import { openSession } from "./lib/session.mjs";

export const USAGE = `behaviour: holds a binding to the states a page puts a form through

Usage
  node binding-kit/behaviour.mjs --binding <datum | id | package path> [--only ids] [--browser chromium|firefox|webkit] [--port n] [--report dir] [--list]
Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = "kit-behaviour";

class Fail extends Error {}
class Skip extends Error {}

const FORM = formOf(
  [
    { id: "name", type: "text", configuration: { label: "Full name", autocomplete: "name" } },
    { id: "email", type: "text", configuration: { label: "Email address", autocomplete: "email" } },
    { id: "province", type: "select", configuration: { label: "Province", autocomplete: "address-level1", options: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Quebec" }, { value: "BC", label: "British Columbia" }] } },
    { id: "notes", type: "textarea", configuration: { label: "Notes" } }
  ],
  "behaviour"
);

/** What a case may do: assertions and the page. */
function context(session, opened) {
  const { page } = opened;
  const c = {
    /** Whether the binding declares an adapter for `type` (else Datum's draws it and there is nothing of the binding to hold). */
    has: (type) => opened.bcInfo?.types?.[type] !== undefined,
    page,
    session,
    sleep,
    fail(message) { throw new Fail(message); },
    skip(reason) { throw new Skip(reason); },
    assert(condition, message) { if (!condition) throw new Fail(message); },
    eq(actual, expected, what) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    ev: (expr) => page.evaluate(expr),
    mountElement: (extra = {}) => page.evaluate(`kit.mountElement(${JSON.stringify({ definition: FORM, assets: session.assets, ...extra })})`),
    state: () => page.evaluate("kit.elementState()"),
    async type(id, text) {
      c.assert(await page.evaluate(`kit.focus(${JSON.stringify(id)})`), `no control of "${id}" took focus`);
      for (const ch of text) { await page.keyboard.insertText(ch); await sleep(20); }
      await page.evaluate("kit.blur()");
      await page.evaluate("kit.painted()");
      await sleep(150);
    },
    async clean() {
      const events = await page.evaluate("kit.events()");
      const errors = events.filter((e) => e.type === "datum-binding-error" || e.type === "datum-error");
      if (errors.length > 0) c.fail(`the form reported ${errors.length} error event(s): ${JSON.stringify(errors[0]).slice(0, 240)}`);
      const exceptions = opened.console.filter((line) => line.startsWith("exception:"));
      if (exceptions.length > 0) c.fail(`the page raised: ${exceptions[0]}`);
    }
  };
  return c;
}

const CASES = [
  {
    id: "BF-01",
    needs: ["text"],
    title: "back/forward without the page cache draws the form again, in the design system's look",
    async run(c) {
      const { page, session } = c;
      await c.mountElement({ persistKey: KEY });
      await c.type("name", "Ada Lovelace");
      c.eq((await c.state()).values.name, "Ada Lovelace", "the answer typed before leaving");
      const before = await page.evaluate('kit.look("name")');
      await page.goto(`${session.origin}${session.urls.blankUrl}`);
      await page.goBack();
      await session.prepare(page, { bc: false });
      c.eq(await page.evaluate("kit.navigationType()"), "back_forward", "navigation type after going back");
      const persisted = await page.evaluate("window.__pageshows ?? []");
      c.assert(!persisted.includes(true), "the page came from the page cache: the case needs a back navigation that reloads (the server answers no-store and the browser runs without the cache)");
      await c.mountElement({ persistKey: KEY });
      const state = await c.state();
      c.eq(state.forms, 1, "forms drawn after coming back");
      c.eq(state.values.name, "Ada Lovelace", "the answer kept across the reload");
      c.eq((await page.evaluate('kit.shown("name")')).shown, "Ada Lovelace", "what the control shows after coming back");
      c.eq(await page.evaluate('kit.look("name")'), before, "how the control looks after coming back (assets fetched again)");
      await c.clean();
    }
  },
  {
    id: "BF-02",
    needs: ["text"],
    title: "a page-cache restore (pageshow, persisted) leaves the form drawn and taking input",
    async run(c) {
      const { page } = c;
      await c.mountElement();
      const before = await page.evaluate('kit.look("name")');
      await page.evaluate("kit.pageshow(true)");
      await sleep(200);
      await c.type("name", "Grace");
      const state = await c.state();
      c.eq(state.forms, 1, "forms drawn after pageshow");
      c.eq(state.values.name, "Grace", "an answer typed after the restore");
      c.eq(await page.evaluate('kit.look("name")'), { ...before }, "how the control looks after the restore");
      await c.clean();
    }
  },
  {
    id: "AF-01",
    needs: ["text"],
    title: "autofill on a text field reaches the answer and survives a redraw",
    async run(c) {
      const { page } = c;
      await c.mountElement();
      c.assert(await page.evaluate('kit.autofill({ id: "email", value: "ada@example.org" })'), "no control to autofill");
      await sleep(250);
      await page.evaluate("kit.painted()");
      c.eq((await c.state()).values.email, "ada@example.org", "the answer after autofill");
      c.eq((await page.evaluate('kit.shown("email")')).shown, "ada@example.org", "what the control shows after autofill");
      // A redraw (another answer changes) must not put the old value back.
      await c.type("name", "Ada");
      c.eq((await page.evaluate('kit.shown("email")')).shown, "ada@example.org", "the autofilled box after another field redraws");
      await c.clean();
    }
  },
  {
    id: "AF-02",
    needs: ["select"],
    title: "autofill on a select reaches the answer",
    async run(c) {
      const { page } = c;
      await c.mountElement();
      // A browser autofills a native <select> only: a select drawn as a custom listbox (a combobox found by role, in the composed tree) with no native <select> has nothing it fills, as VAL-05 skips.
      // Nothing found at all falls through to the failure below.
      const drawn = await page.evaluate(`(() => {
        const wrapper = document.querySelector("[data-kit-element],[data-bc-host]")?.shadowRoot?.querySelector('[data-component-id="province"]');
        const deep = (root, selector, out = []) => {
          for (const el of root.querySelectorAll("*")) {
            if (el.matches(selector)) out.push(el);
            if (el.shadowRoot) deep(el.shadowRoot, selector, out);
          }
          return out;
        };
        return wrapper ? { select: deep(wrapper, "select").length, combobox: deep(wrapper, "[role=combobox]").length } : null;
      })()`);
      if (drawn !== null && drawn.select === 0 && drawn.combobox > 0) c.skip("no native <select> under the field, a [role=combobox] listbox instead, which a browser does not autofill");
      c.assert(await page.evaluate('kit.autofill({ id: "province", value: "QC" })'), "no control to autofill");
      await sleep(250);
      await page.evaluate("kit.painted()");
      c.eq((await c.state()).values.province, "QC", "the answer after autofill");
      await c.clean();
    }
  },
  {
    id: "AF-03",
    needs: ["text"],
    title: "a field's autocomplete token reaches the control a browser autofills",
    async run(c) {
      await c.mountElement();
      const name = await c.ev('kit.controlAttributes("name")');
      const email = await c.ev('kit.controlAttributes("email")');
      c.assert(name !== null && email !== null, "a field drew no control");
      c.eq(name.autocomplete, "name", 'autocomplete of the "name" field');
      c.eq(email.autocomplete, "email", 'autocomplete of the "email" field');
      await c.clean();
    }
  },
  {
    id: "MV-01",
    needs: ["text"],
    title: "the element taken out and put back in the same task keeps its form",
    async run(c) {
      await c.mountElement();
      await c.ev('kit.addContainer("second")');
      await c.type("name", "Ada");
      const before = await c.ev('kit.look("name")');
      await c.ev('kit.moveElement({ delay: 0, into: "#second" })');
      const state = await c.state();
      c.eq(state.forms, 1, "forms drawn after the move");
      c.eq(state.values.name, "Ada", "the answer after the move");
      c.eq(await c.ev('kit.look("name")'), before, "how the control looks after the move");
      await c.type("email", "a@b.co");
      c.eq((await c.state()).values.email, "a@b.co", "an answer typed after the move");
      await c.clean();
    }
  },
  {
    id: "MV-02",
    needs: ["text"],
    title: "the element put back later draws again: answers kept, the design system's look, no errors",
    async run(c) {
      await c.mountElement();
      await c.type("name", "Ada");
      const before = await c.ev('kit.look("name")');
      await c.ev('kit.moveElement({ delay: 150 })');
      await sleep(200);
      const state = await c.state();
      c.eq(state.forms, 1, "forms drawn after the element came back");
      if (state.alert) c.fail(`an alert took the form's place: ${state.alert}`);
      c.eq(state.values.name, "Ada", "the answer after the element came back");
      c.eq((await c.ev('kit.shown("name")')).shown, "Ada", "what the control shows after the element came back");
      c.eq(await c.ev('kit.look("name")'), before, "how the control looks after the element came back");
      await c.clean();
    }
  },
  {
    id: "MV-03",
    needs: ["text"],
    title: "a host the renderer was mounted on (mountLive) moved in the DOM keeps working",
    async run(c) {
      const { page, session } = c;
      const payload = { definition: FORM, assets: session.assets };
      await page.evaluate(`bc.mount(${JSON.stringify(payload)})`);
      await c.ev('kit.addContainer("second")');
      const before = await c.ev('kit.look("name")');
      c.assert(await c.ev('kit.focus("name")'), "no control took focus before the move");
      await c.ev('kit.moveHost("#second")');
      await sleep(150);
      c.eq(await c.ev('kit.look("name")'), before, "how the control looks after the move");
      c.assert(await c.ev('kit.focus("name")'), "no control took focus after the move");
      for (const ch of "Ada") { await page.keyboard.insertText(ch); await sleep(20); }
      await c.ev("bc.blur()");
      await c.ev("bc.settle(150)");
      c.eq((await c.ev("bc.values()")).name, "Ada", "an answer typed after the move");
      await c.clean();
    }
  },
  {
    id: "MV-04",
    needs: ["text"],
    title: "the element removed for good takes its sheets and fonts with it",
    async run(c) {
      const before = await c.ev("bc.docSnapshot()");
      await c.mountElement();
      await c.ev('document.querySelector("[data-kit-element]").remove()');
      await sleep(250);
      const state = await c.state();
      c.eq(state.forms, 0, "forms drawn after the element left the page");
      c.eq(await c.ev("bc.docSnapshot()"), before, "what the page holds (links, styles, adopted sheets) against before the form was mounted");
      await c.clean();
    }
  }
];

/**
 * The known defects a binding declares (`known` in its binding-check.json), each a case of this suite or of the
 * conformance suite: `[{ case, reason, since }]`. Throws a PreflightError that names a bad entry, or an id that
 * matches no case of either suite.
 */
export function knownOf(pkg) {
  return readRouting(pkg.assets, pkg.assetsFile ?? `bindings/${pkg.id}/binding-check.json`, { cases: [...CASES.map((c) => c.id), ...CONFORMANCE_CASES.map((c) => c.id)] }).known;
}

/** Runs the cases. Resolves to `{ exit, cases, summary }`. */
export async function runBehaviour(binding, options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const pkg = typeof binding === "string" ? resolveBinding(binding) : binding;
  const selected = CASES.filter((c) => !options.only?.length || options.only.includes(c.id));
  if (selected.length === 0) {
    log(`behaviour ${pkg.id}: --only ${options.only.join(",")} selects no case`);
    return { exit: 2, cases: [], summary: { pass: 0, fail: 0, skip: 0, known: 0 } };
  }
  const known = new Map(knownOf(pkg).filter((entry) => CASES.some((c) => c.id === entry.case)).map((entry) => [entry.case, entry]));
  const own = !options.session;
  const session = options.session ?? (await openSession(pkg, { browserName: options.browserName, port: options.port }));
  const results = [];
  try {
    log(`behaviour ${pkg.id} on ${session.browser.version}: ${selected.length} case(s)`);
    for (const entry of known.values()) if (selected.some((test) => test.id === entry.case)) log(`  known defect ${entry.case}: ${entry.reason} (since ${entry.since})`);
    for (const test of selected) {
      const opened = await session.newPage({ bc: true, initScript: "window.__pageshows = []; addEventListener('pageshow', (e) => window.__pageshows.push(e.persisted));" });
      const started = Date.now();
      let result;
      let internal = false;
      try {
        const c = context(session, opened);
        const missing = (test.needs ?? []).filter((type) => !c.has(type));
        if (missing.length > 0) c.skip(`the binding declares no adapter for ${missing.map((t) => `"${t}"`).join(", ")}: Datum draws it, so there is nothing of the binding to hold`);
        await test.run(c);
        result = { id: test.id, title: test.title, status: "pass" };
      } catch (error) {
        if (error instanceof Skip) result = { id: test.id, title: test.title, status: "skip", reason: error.message };
        else {
          internal = !(error instanceof Fail);
          result = { id: test.id, title: test.title, status: "fail", reason: error instanceof Fail ? error.message : `error: ${String(error?.stack ?? error).split("\n").slice(0, 3).join(" / ")}` };
        }
      } finally {
        result = { ...(result ?? {}), ms: Date.now() - started, console: opened.console.filter((line) => !line.startsWith("warning:")).slice(0, 5) };
        await opened.close();
      }
      // A listed case: a failure is the design system's, declared and counted apart; a pass means the list is stale.
      const listed = known.get(test.id);
      if (listed && result.status === "fail" && !internal) result = { ...result, status: "known", known: listed.reason, reason: `${listed.reason}\n         still fails: ${result.reason}` };
      else if (listed && result.status === "pass") result = { ...result, status: "fail", reason: `listed as known but passes: remove it from "known" in binding-check.json (${listed.reason})` };
      results.push(result);
      log(`  ${result.status.toUpperCase().padEnd(5)} ${test.id}  ${test.title}${result.reason ? `\n         ${result.reason}` : ""}`);
    }
    // Offline: a request nothing answered is a failure of the run (see lib/session.mjs).
    const offline = session.takeOffline();
    for (const note of offline.notes) log(`  ${note}`);
    for (const problem of offline.problems) {
      results.push({ id: "offline", title: "no request beyond the session's server", status: "fail", reason: problem, ms: 0, console: [] });
      log(`  FAIL  offline\n         ${problem}`);
    }
  } finally {
    if (own) await session.close();
  }
  const summary = { pass: 0, fail: 0, skip: 0, known: 0 };
  for (const r of results) summary[r.status] += 1;
  const exit = summary.fail > 0 ? 1 : summary.pass === 0 ? 2 : 0;
  log(`behaviour ${pkg.id}: ${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skip${summary.known > 0 ? `, ${summary.known} known` : ""}`);
  if (options.report) {
    mkdirSync(options.report, { recursive: true });
    writeFileSync(join(options.report, "behaviour.json"), JSON.stringify({ tool: "binding-kit behaviour", binding: pkg.id, browser: session.browser.version, at: new Date().toISOString(), cases: results }, null, 2));
  }
  return { exit, cases: results, summary };
}

export async function main(argv) {
  const args = { only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === "--binding") args.binding = next();
    else if (arg === "--only") args.only = next().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === "--browser") args.browserName = next();
    else if (arg === "--port") args.port = Number(next());
    else if (arg === "--report") args.report = resolve(next());
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else { console.error(`unknown option ${arg}\n${USAGE}`); return 2; }
  }
  if (args.list) { for (const c of CASES) console.log(`${c.id.padEnd(6)} ${c.title}`); return 0; }
  if (args.help || !args.binding) { console.log(USAGE); return args.help ? 0 : 2; }
  let pkg;
  try { pkg = resolveBinding(args.binding); } catch (error) { console.error(error.message); return 2; }
  try {
    return (await runBehaviour(pkg, args)).exit;
  } catch (error) {
    if (error instanceof PreflightError) { console.error(error.message); return 3; }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(`behaviour: ${error?.stack ?? error}`); process.exitCode = 4; }
  );
}
